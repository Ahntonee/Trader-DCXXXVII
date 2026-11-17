'use strict';
const crypto = require('crypto');
const { db } = require('./db');

// ═══════════════════════════════════════════════════════════════════
// AUDIT LOG — tamper-evident, append-only decision record.
//
// Every row commits to the previous row's hash (a hash chain), so editing,
// deleting or reordering any past entry breaks verification from that point.
// Batches of rows are summarised by a Merkle root; the root is what gets
// anchored on the Concordium chain (see audit_anchors.tx_hash), so a third
// party can later prove the log existed in exactly this form at that time.
//
// Design rules:
//  - NO personal data. Actors are roles ('system', 'admin'), never IPs/names.
//  - Append-only at the database level (triggers abort UPDATE/DELETE).
//  - Deterministic: canonical JSON (sorted keys) so any party can recompute.
// ═══════════════════════════════════════════════════════════════════

const GENESIS = '0'.repeat(64);

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    seq        INTEGER PRIMARY KEY,
    ts         INTEGER NOT NULL,
    type       TEXT    NOT NULL,
    actor      TEXT    NOT NULL,
    payload    TEXT    NOT NULL,
    prev_hash  TEXT    NOT NULL,
    hash       TEXT    NOT NULL UNIQUE
  );
  CREATE TRIGGER IF NOT EXISTS audit_log_no_update
    BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
    BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

  CREATE TABLE IF NOT EXISTS audit_anchors (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_seq   INTEGER NOT NULL,
    to_seq     INTEGER NOT NULL,
    root       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    tx_hash    TEXT,
    network    TEXT
  );
`);

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// Deterministic JSON: object keys sorted recursively, no whitespace.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function rowHash(prevHash, seq, ts, type, actor, payloadJson) {
  return sha256(`${prevHash}|${seq}|${ts}|${type}|${actor}|${payloadJson}`);
}

const _last   = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
const _insert = db.prepare(`INSERT INTO audit_log (seq,ts,type,actor,payload,prev_hash,hash)
                            VALUES (@seq,@ts,@type,@actor,@payload,@prev_hash,@hash)`);

// better-sqlite3 is synchronous, so read-last + insert inside one transaction
// is atomic: concurrent callers can never fork the chain.
const _append = db.transaction((type, actor, payload, ts) => {
  const last = _last.get();
  const seq = last ? last.seq + 1 : 1;
  const prev = last ? last.hash : GENESIS;
  const payloadJson = canonical(payload ?? {});
  const hash = rowHash(prev, seq, ts, type, actor, payloadJson);
  _insert.run({ seq, ts, type, actor, payload: payloadJson, prev_hash: prev, hash });
  return { seq, hash };
});

// Never throws into trading logic: an audit failure is logged loudly instead.
function append(type, actor, payload = {}) {
  try {
    return _append(String(type), String(actor), payload, Date.now());
  } catch (e) {
    console.error('[Audit] APPEND FAILED:', e.message);
    return null;
  }
}

// Recompute the chain over [fromSeq, toSeq] (inclusive; defaults = everything).
function verify(fromSeq = 1, toSeq = Number.MAX_SAFE_INTEGER) {
  const rows = db.prepare('SELECT * FROM audit_log WHERE seq BETWEEN ? AND ? ORDER BY seq').all(fromSeq, toSeq);
  let prev = null;
  if (fromSeq > 1) {
    const before = db.prepare('SELECT hash FROM audit_log WHERE seq = ?').get(fromSeq - 1);
    prev = before ? before.hash : null;
  } else prev = GENESIS;

  let expectedSeq = rows.length ? rows[0].seq : null;
  for (const r of rows) {
    if (r.seq !== expectedSeq)           return { ok: false, checked: 0, brokenAt: expectedSeq, reason: 'missing row (sequence gap)' };
    if (prev !== null && r.prev_hash !== prev) return { ok: false, checked: 0, brokenAt: r.seq, reason: 'prev_hash does not match previous row' };
    if (rowHash(r.prev_hash, r.seq, r.ts, r.type, r.actor, r.payload) !== r.hash)
                                         return { ok: false, checked: 0, brokenAt: r.seq, reason: 'row content does not match its hash' };
    prev = r.hash;
    expectedSeq++;
  }
  return { ok: true, checked: rows.length, from: rows[0]?.seq ?? null, to: rows.at(-1)?.seq ?? null,
           head: rows.at(-1)?.hash ?? null };
}

// Binary Merkle tree over leaf hashes (odd node is promoted by duplication).
function merkleRoot(leaves) {
  if (!leaves.length) return null;
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + (level[i + 1] ?? level[i])));
    level = next;
  }
  return level[0];
}

// Summarise all not-yet-anchored rows into a checkpoint. The root is what
// you submit on-chain; call recordAnchorTx() once the transaction exists.
function createCheckpoint() {
  const lastAnchor = db.prepare('SELECT to_seq FROM audit_anchors ORDER BY id DESC LIMIT 1').get();
  const from = (lastAnchor?.to_seq ?? 0) + 1;
  const rows = db.prepare('SELECT seq, hash FROM audit_log WHERE seq >= ? ORDER BY seq').all(from);
  if (!rows.length) return null;
  const chain = verify(from, rows.at(-1).seq);
  if (!chain.ok) throw new Error(`refusing to checkpoint a broken chain: ${chain.reason} at seq ${chain.brokenAt}`);
  const root = merkleRoot(rows.map(r => r.hash));
  const info = db.prepare('INSERT INTO audit_anchors (from_seq,to_seq,root,created_at) VALUES (?,?,?,?)')
    .run(from, rows.at(-1).seq, root, Date.now());
  return { id: info.lastInsertRowid, from_seq: from, to_seq: rows.at(-1).seq, root };
}

function recordAnchorTx(id, txHash, network = 'concordium-testnet') {
  db.prepare('UPDATE audit_anchors SET tx_hash=?, network=? WHERE id=?').run(txHash, network, id);
}

// Prove an anchored root still matches the log as it stands today.
function verifyAnchor(id) {
  const a = db.prepare('SELECT * FROM audit_anchors WHERE id=?').get(id);
  if (!a) return { ok: false, reason: 'unknown anchor' };
  const chain = verify(a.from_seq, a.to_seq);
  if (!chain.ok) return { ok: false, reason: chain.reason, brokenAt: chain.brokenAt };
  const rows = db.prepare('SELECT hash FROM audit_log WHERE seq BETWEEN ? AND ? ORDER BY seq').all(a.from_seq, a.to_seq);
  const root = merkleRoot(rows.map(r => r.hash));
  return { ok: root === a.root, anchor: a, recomputedRoot: root };
}

const list = (afterSeq = 0, limit = 100) =>
  db.prepare('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?')
    .all(Math.max(0, afterSeq | 0), Math.min(Math.max(limit | 0, 1), 500))
    .map(r => ({ ...r, payload: JSON.parse(r.payload) }));

const anchors = () => db.prepare('SELECT * FROM audit_anchors ORDER BY id DESC LIMIT 100').all();
const head = () => _last.get() || null;

module.exports = { append, verify, createCheckpoint, recordAnchorTx, verifyAnchor, list, anchors, head,
                   canonical, merkleRoot, GENESIS };
