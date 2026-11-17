'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apex-audit-')), 'a.db');
process.env.DB_PATH = tmp;

const { test, after } = require('node:test');
const assert = require('node:assert');
const { db } = require('../db');
const audit = require('../audit');

after(() => { try { db.close(); fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch { } });

test('canonical JSON is key-order independent', () => {
  assert.strictEqual(audit.canonical({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }),
                     audit.canonical({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
});

test('chain verifies and every row links to the previous hash', () => {
  for (let i = 0; i < 5; i++) audit.append('signal_created', 'system', { id: `s${i}`, entry: 100 + i });
  const v = audit.verify();
  assert.strictEqual(v.ok, true); assert.strictEqual(v.checked, 5);
  const rows = audit.list(0, 10);
  assert.strictEqual(rows[0].prev_hash, audit.GENESIS);
  for (let i = 1; i < rows.length; i++) assert.strictEqual(rows[i].prev_hash, rows[i - 1].hash);
});

test('database triggers make the log append-only', () => {
  assert.throws(() => db.prepare("UPDATE audit_log SET type='x' WHERE seq=2").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log WHERE seq=2').run(), /append-only/);
});

test('tampering with a row (triggers bypassed) is detected at the exact row', () => {
  db.exec('DROP TRIGGER audit_log_no_update');
  db.prepare("UPDATE audit_log SET payload='{\"id\":\"s2\",\"entry\":999}' WHERE seq=3").run();
  const v = audit.verify();
  assert.strictEqual(v.ok, false); assert.strictEqual(v.brokenAt, 3);
  assert.match(v.reason, /does not match its hash/);
});

test('checkpoint refuses a broken chain; clean chain yields stable Merkle root + anchor verify', () => {
  assert.throws(() => audit.createCheckpoint(), /broken chain/);
  // Rebuild a clean DB state in a fresh table to prove the anchor flow.
  db.exec('DROP TABLE audit_log; DROP TABLE audit_anchors;');
  delete require.cache[require.resolve('../audit')];
  const fresh = require('../audit');
  for (let i = 0; i < 7; i++) fresh.append('signal_entered', 'system', { id: `n${i}` });
  const cp = fresh.createCheckpoint();
  assert.strictEqual(cp.from_seq, 1); assert.strictEqual(cp.to_seq, 7);
  assert.match(cp.root, /^[0-9a-f]{64}$/);
  assert.strictEqual(fresh.createCheckpoint(), null);            // nothing new
  assert.strictEqual(fresh.verifyAnchor(cp.id).ok, true);
  fresh.recordAnchorTx(cp.id, 'a'.repeat(64));
  assert.strictEqual(fresh.anchors()[0].tx_hash, 'a'.repeat(64));
  // Tamper after anchoring → anchor no longer verifies.
  db.exec('DROP TRIGGER audit_log_no_update');
  db.prepare("UPDATE audit_log SET actor='attacker' WHERE seq=4").run();
  assert.strictEqual(fresh.verifyAnchor(cp.id).ok, false);
});

test('agent-card.json is valid JSON with the required ERC-8004 / A2A top-level fields', () => {
  const card = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agent-card.json'), 'utf8'));
  assert.strictEqual(card.type, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
  for (const k of ['name', 'description', 'version', 'supportedInterfaces', 'capabilities', 'skills', 'services', 'x402Support', 'active', 'registrations'])
    assert.ok(k in card, `missing ${k}`);
  assert.ok(card.name.length <= 128 && card.description.length <= 2048);
});
