'use strict';
// config.js calls require('dotenv').config() — must be first so env vars
// are loaded before any other module reads process.env.
const {
  PORT, HOST, TWELVE_KEY, VALID_SYMBOL, VALID_INTERVAL, sanitizeLimit,
  CRYPTO_PAIRS, FOREX_PAIRS, TIMEFRAMES, MTF_MAP, CANDLE_LIMIT,
  MAX_CORRELATED, BACKTEST_COOLDOWN_MS,
} = require('./config');
const {
  getLiveKlines, getLiveTicker, getForexKlines, getForexPrice,
} = require('./data-sources');

const express           = require('express');
const http              = require('http');
const { WebSocketServer } = require('ws');
const path              = require('path');
const db                = require('./db');
const engine            = require('./signal-engine');
const tg                = require('./telegram');
const { runBacktest }   = require('./backtester');

// Candle cache for structure-based trailing stop — keyed by pairId+tf
const _candleCache = {};

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════════
// WEBSOCKET BROADCAST
// ═══════════════════════════════════════════════════════════════════

function broadcast(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(str); });
}

// All-time summary merged with today-scoped counts (fired/expired today).
// "Today" = since UTC midnight, matching the client's UTC date filter.
function summaryPayload() {
  const s = db.getSignalSummary.get();
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const t = db.getTodaySummary.get({ todayStart });
  return { ...s, fired_today: t.fired_today || 0, expired_today: t.expired_today || 0 };
}

function broadcastSessions() {
  broadcast({
    type:    'sessions',
    active:  engine.getMarketSessions(),
    bonus:   engine.getSessionBonus(),
    utcHour: new Date().getUTCHours(),
  });
}

wss.on('connection', ws => {
  try {
    const active = db.getActiveSignals.all();
    ws.send(JSON.stringify({ type: 'signals_init', data: active }));
    const journal = db.getJournal.all();
    ws.send(JSON.stringify({ type: 'journal_init', data: journal }));
    const stats = db.getPatternStats.all();
    ws.send(JSON.stringify({ type: 'stats_init', data: stats }));
    const btResults = db.getBacktestResults.all();
    if (btResults.length) ws.send(JSON.stringify({ type: 'backtest_results', data: btResults }));
    ws.send(JSON.stringify({ type: 'summary_init', data: summaryPayload() }));
    ws.send(JSON.stringify({
      type: 'sessions', active: engine.getMarketSessions(),
      bonus: engine.getSessionBonus(), utcHour: new Date().getUTCHours(),
    }));
  } catch (e) { console.warn('WS init error:', e.message); }
});

// ═══════════════════════════════════════════════════════════════════
// SIGNAL PROCESSING
// ═══════════════════════════════════════════════════════════════════

async function processNewSignal(sig) {
  try {
    // ── Correlation cap ───────────────────────────────────────────
    // Count active signals in the same direction (pending or entered).
    // MTF stacks on the SAME pair are exempt — they are one trade.
    const allActive = db.getActiveSignals.all();
    const sameDir = allActive.filter(s =>
      s.dir === sig.dir &&
      s.pair_id !== sig.pair_id &&
      ['pending', 'entered', 'tp1_hit'].includes(s.status)
    );
    if (sameDir.length >= MAX_CORRELATED) {
      console.log(`[Cap] ${sig.dir.toUpperCase()} ${sig.sym} blocked — ${sameDir.length} ${sig.dir} signals already active (cap: ${MAX_CORRELATED})`);
      return;
    }

    // ── MTF confluence check ─────────────────────────────────────
    // If another active signal for the same pair + direction already
    // exists on a DIFFERENT timeframe, both signals are "stacked" —
    // the incoming one is marked MULTI-TF and gets a confidence boost.
    const existing = db.getActiveSignals.all().filter(s =>
      s.pair_id  === sig.pair_id &&
      s.dir      === sig.dir     &&
      s.tf       !== sig.tf      &&
      ['pending','entered'].includes(s.status)
    );
    if (existing.length > 0) {
      sig = {
        ...sig,
        mtf_stack:  true,
        mtf_tfs:    [...new Set([...existing.map(s => s.tf), sig.tf])].join('+'),
        confidence: Math.min(sig.confidence + 4, 96),
        filters:    sig.filters ? sig.filters + ' · ✦ MULTI-TF' : '✦ MULTI-TF',
      };
      console.log(`[MTF] ${sig.sym} ${sig.dir.toUpperCase()} stacked on ${sig.mtf_tfs}`);
    }

    db.insertSignal.run({
      ...sig,
      candle_pattern: sig.candle_pattern  ?? null,
      htf_bias:       sig.htf_bias        ?? 'neutral',
      adx:            sig.adx             ?? null,
      tier:           sig.tier            ?? null,
      votes:          sig.votes           ?? null,
      ci:             sig.ci              ?? null,
      struct_label:   sig.struct_label    ?? null,
      entry_mode:     sig.entry_mode      ?? null,
      mtf_stack:      sig.mtf_stack       ? 1 : 0,
      mtf_tfs:        sig.mtf_tfs         ?? null,
      vpvr_label:     sig.vpvr_label      ?? null,
      vol_regime:     sig.vol_regime      ?? null,
      size_mult:      sig.size_mult       ?? null,
    });
    broadcast({ type: 'new_signal', data: sig });
    broadcast({ type: 'summary_init', data: summaryPayload() });
    const tgMsg = tg.formatSignal(sig);
    await tg.sendMessage(tgMsg);
    console.log(`[SIGNAL] ${sig.dir.toUpperCase()} ${sig.sym} ${sig.tf} | ${sig.pattern} | Conf: ${sig.confidence}%${sig.mtf_stack ? ' | ✦ MTF' : ''} | ADX: ${sig.adx}`);
  } catch (e) {
    console.warn('[processNewSignal] error:', e.message);
  }
}

function handleSignalUpdate(sig, updates) {
  try {
    db.updateSignalStatus.run({
      id: sig.id,
      status: updates.status,
      entry_price: updates.entry_price ?? sig.entry_price ?? null,
      close_price: updates.close_price ?? null,
      r_mult: updates.r_mult ?? null,
      entered_at: updates.entered_at ?? null,
      closed_at: updates.closed_at ?? null,
    });
    broadcast({ type: 'signal_update', id: sig.id, updates });

    // ── TP1 HIT: lock 30% at +1.0R, arm structure trailing stop ──────
    if (updates.status === 'tp1_hit') {
      const entryPx   = updates.entry_price ?? sig.entry_price ?? sig.entry;
      const exitPrice = updates.close_price || sig.tp1;

      // Set trail stop to breakeven — structure trail will only move it in favour
      db.updateSignalSL.run({ id: sig.id, sl: entryPx });
      broadcast({ type: 'signal_update', id: sig.id, updates: { sl: entryPx } });

      // Journal: 30% partial exit at 1.0R (tiered exit v3)
      const pnlPct = entryPx > 0 ? ((exitPrice - entryPx) / entryPx * (sig.dir === 'long' ? 100 : -100)) : 0;
      db.insertJournal.run({
        signal_id: sig.id, sym: sig.sym, tf: sig.tf, dir: sig.dir,
        pattern: sig.pattern, htf_bias: sig.htf_bias,
        entry: entryPx, exit_price: exitPrice,
        sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
        outcome: 'tp1', r_mult: 1.0, pnl_pct: +pnlPct.toFixed(3),
        confidence: sig.confidence,
        opened_at: sig.entered_at || sig.detected_at,
        closed_at: updates.closed_at,
        date: new Date().toISOString().slice(0, 10),
      });
      db.upsertPatternStat.run({
        pattern: sig.pattern, tf: sig.tf, asset_class: sig.asset_class || 'crypto',
        wins: 1, losses: 0, total_r: 1.0, count: 1, win_rate: 1, avg_r: 1.0,
      });
      broadcast({ type: 'journal_update', data: db.getJournal.all() });
      broadcast({ type: 'summary_init', data: summaryPayload() });
      tg.sendMessage(tg.formatTPHit(sig, 'tp1'));
      console.log(`[TRAIL] ${sig.sym} TP1 hit — 30% locked +1.0R, structure trailing stop armed at breakeven`);
    }

    // ── TRAIL CLOSE or TP2: log remaining position ────────────────
    if (['tp2_hit', 'sl_hit'].includes(updates.status)) {
      const wasTrailing = sig.status === 'tp1_hit';
      const entryPx    = sig.entry_price ?? sig.entry;
      const exitPrice  = updates.close_price ?? (updates.status === 'sl_hit' ? sig.sl : sig.tp2);

      let rMult;
      if (wasTrailing) {
        // risk unit is 1.0R (TP1 = 1.0R in v3)
        const risk = Math.abs(sig.tp1 - sig.entry) / 1.0;
        rMult = risk > 0
          ? (sig.dir === 'long' ? (exitPrice - entryPx) : (entryPx - exitPrice)) / risk
          : 0;
        rMult = Math.max(0, +rMult.toFixed(3));
      } else {
        rMult = updates.status === 'sl_hit' ? -1 : 2.0; // TP2 is 2.0R in v3
      }

      const outcome = wasTrailing
        ? (updates.status === 'tp2_hit' ? 'tp2' : 'trail')
        : updates.status.replace('_hit', '');
      const pnlPct = entryPx > 0
        ? ((exitPrice - entryPx) / entryPx * (sig.dir === 'long' ? 100 : -100))
        : 0;

      db.insertJournal.run({
        signal_id: sig.id, sym: sig.sym, tf: sig.tf, dir: sig.dir,
        pattern: sig.pattern, htf_bias: sig.htf_bias,
        entry: entryPx, exit_price: exitPrice,
        sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
        outcome, r_mult: rMult, pnl_pct: +pnlPct.toFixed(3),
        confidence: sig.confidence,
        opened_at: sig.entered_at || sig.detected_at,
        closed_at: updates.closed_at,
        date: new Date().toISOString().slice(0, 10),
      });
      db.upsertPatternStat.run({
        pattern: sig.pattern, tf: sig.tf, asset_class: sig.asset_class || 'crypto',
        wins: rMult > 0 ? 1 : 0, losses: rMult <= 0 ? 1 : 0,
        total_r: rMult, count: 1,
        win_rate: rMult > 0 ? 1 : 0, avg_r: rMult,
      });
      broadcast({ type: 'journal_update', data: db.getJournal.all() });
      broadcast({ type: 'summary_init', data: summaryPayload() });

      if (updates.status === 'sl_hit') tg.sendMessage(tg.formatSLHit(sig));
      else tg.sendMessage(tg.formatTPHit(sig, outcome));

      if (wasTrailing)
        console.log(`[TRAIL] ${sig.sym} trail closed — 50% at ${rMult >= 0 ? '+' : ''}${rMult}R (exit: ${exitPrice})`);
    }
  } catch (e) {
    console.warn('[handleSignalUpdate] error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// STRUCTURE-BASED TRAILING STOP
// After TP1 is hit, trail behind the most recent confirmed swing low
// (long) or swing high (short). Falls back to 0.5R arithmetic trail
// when the candle cache is cold. Stop only moves in favour — never back.
// ═══════════════════════════════════════════════════════════════════

function computeTrailStop(sig, price) {
  const cacheKey = `${sig.pair_id}_${sig.tf}`;
  const cachedCandles = _candleCache[cacheKey];
  if (cachedCandles && cachedCandles.length >= 20) {
    const newSL = engine.computeStructureTrail(sig, cachedCandles);
    if (newSL !== null) return newSL;
  }
  // Arithmetic fallback (0.5R) — matches old behaviour when cache is cold
  const originalRisk = Math.abs(sig.tp1 - sig.entry) / 1.0; // TP1 is 1.0R in v3
  if (!originalRisk) return null;
  const trailDist = originalRisk * 0.5;
  if (sig.dir === 'long') {
    const t = price - trailDist;
    return t > sig.sl ? +t.toFixed(8) : null;
  } else {
    const t = price + trailDist;
    return t < sig.sl ? +t.toFixed(8) : null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// LIVE PRICE TRACKING & SIGNAL STATUS UPDATES
// ═══════════════════════════════════════════════════════════════════

const _latestPrices = {};

async function updateCryptoPrices() {
  for (const pair of CRYPTO_PAIRS) {
    try {
      const ticker = await getLiveTicker(pair.id);
      const price = +ticker.lastPrice, chg = +ticker.priceChangePercent;
      _latestPrices[pair.id] = price;
      broadcast({ type: 'price', pairId: pair.id, price, change: chg });

      const active = db.getActiveSignals.all().filter(s => s.pair_id === pair.id);
      for (const sig of active) {
        if (sig.status === 'tp1_hit') {
          const newTrail = computeTrailStop(sig, price);
          if (newTrail !== null) {
            db.updateSignalSL.run({ id: sig.id, sl: newTrail });
            sig.sl = newTrail;
            broadcast({ type: 'signal_update', id: sig.id, updates: { sl: newTrail } });
          }
        }
        const update = engine.updateSignalOnPrice(sig, price);
        if (update) handleSignalUpdate(sig, update);
      }
    } catch { /* ignore individual failures */ }
    await new Promise(r => setTimeout(r, 150));
  }
}

async function updateForexPrices() {
  if (!TWELVE_KEY || TWELVE_KEY === 'your_twelve_data_key_here') return;
  for (const pair of FOREX_PAIRS) {
    try {
      const price = await getForexPrice(pair.id);
      if (!price) continue;
      _latestPrices[pair.id] = price;
      broadcast({ type: 'price', pairId: pair.id, price, change: null });
    } catch { }
    await new Promise(r => setTimeout(r, 400));
  }
}

// ═══════════════════════════════════════════════════════════════════
// SIGNAL SCANNER (runs on intervals)
// ═══════════════════════════════════════════════════════════════════

// Throttle "all sources failed" noise — log once per pair per 10 min
const _failLoggedAt = {};
async function scanOnePair(pair) {
  for (const tf of TIMEFRAMES) {
    try {
      const limit    = CANDLE_LIMIT[tf] || 200;
      const htfTf    = MTF_MAP[tf] || '4h';
      const htfLimit = CANDLE_LIMIT[htfTf] || 100;
      const [candles, htfCandles] = await Promise.all([
        getLiveKlines(pair.id, tf,    limit),
        getLiveKlines(pair.id, htfTf, htfLimit),
      ]);
      _candleCache[`${pair.id}_${tf}`] = candles;
      const newSigs = await engine.scanPair(candles, htfCandles, pair, tf, 'crypto');
      for (const sig of newSigs) await processNewSignal(sig);
    } catch (e) {
      const key = `${pair.id}_${tf}`;
      const now = Date.now();
      if (!_failLoggedAt[key] || now - _failLoggedAt[key] > 600_000) {
        console.warn(`[Scan] ${pair.id} ${tf}:`, e.message);
        _failLoggedAt[key] = now;
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

// Parallel scanner: splits pairs into batches of 3, runs concurrently.
// Expire pending signals before the 18:00 UTC blackout to avoid
// fakeout fills during the dead-hour gap.
function expireBlackoutSignals() {
  const h = new Date().getUTCHours();
  if (h < 18 || h >= 22) return;
  const pending = db.getActiveSignals.all().filter(s => s.status === 'pending');
  for (const sig of pending) {
    db.updateSignalStatus.run({
      id: sig.id, status: 'expired',
      entry_price: null, close_price: null,
      r_mult: null, entered_at: null, closed_at: Date.now(),
    });
    broadcast({ type: 'signal_update', id: sig.id, updates: { status: 'expired' } });
  }
  if (pending.length) {
    console.log(`[Blackout] Expired ${pending.length} pending signal(s) — 18 UTC blackout`);
    broadcast({ type: 'summary_init', data: summaryPayload() });
  }
}

async function scanCryptoSignals() {
  expireBlackoutSignals();
  db.expireOldSignals.run(Date.now());
  const BATCH = 3; // 3 concurrent — less connection pressure on Nigerian network
  for (let i = 0; i < CRYPTO_PAIRS.length; i += BATCH) {
    const batch = CRYPTO_PAIRS.slice(i, i + BATCH);
    await Promise.all(batch.map(pair => scanOnePair(pair).catch(e =>
      console.warn(`[Scan] ${pair.id} batch error:`, e.message)
    )));
    await new Promise(r => setTimeout(r, 800));
  }
}

let _forexScanIdx = 0;
async function scanForexSignals() {
  if (!TWELVE_KEY || TWELVE_KEY === 'your_twelve_data_key_here') return;
  const pair = FOREX_PAIRS[_forexScanIdx % FOREX_PAIRS.length];
  _forexScanIdx++;
  for (const tf of ['1h', '4h', '1d']) {
    try {
      const htfTf = MTF_MAP[tf] || '4h';
      const [candles, htfCandles] = await Promise.all([
        getForexKlines(pair.id, tf,    200),
        getForexKlines(pair.id, htfTf, 100),
      ]);
      if (!candles.length) continue;
      const fakePair = { id: pair.id, sym: pair.sym, dec: pair.dec };
      const newSigs = await engine.scanPair(candles, htfCandles, fakePair, tf, 'forex');
      for (const sig of newSigs) await processNewSignal(sig);
    } catch (e) {
      console.warn(`[ForexScan] ${pair.sym} ${tf}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 800));
  }
}

// Dedicated 15m fast scanner — runs every 90 s, only the 15m TF, all
// pairs in batches of 6. Skips pairs that already have a live 15m signal.
async function scan15mFast() {
  const TF       = '15m';
  const HTF      = MTF_MAP[TF];
  const limit    = CANDLE_LIMIT[TF]  || 200;
  const htfLimit = CANDLE_LIMIT[HTF] || 200;

  const activeTf15 = new Set(
    db.getActiveSignals.all()
      .filter(s => s.tf === TF && ['pending', 'entered', 'tp1_hit'].includes(s.status))
      .map(s => s.pair_id)
  );

  const toScan = CRYPTO_PAIRS.filter(p => !activeTf15.has(p.id));
  if (!toScan.length) return;

  const BATCH = 6;
  let found = 0;
  for (let i = 0; i < toScan.length; i += BATCH) {
    const batch = toScan.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(async pair => {
      const [candles, htfCandles] = await Promise.all([
        getLiveKlines(pair.id, TF,  limit),
        getLiveKlines(pair.id, HTF, htfLimit),
      ]);
      _candleCache[`${pair.id}_${TF}`] = candles;
      const newSigs = await engine.scanPair(candles, htfCandles, pair, TF, 'crypto');
      for (const sig of newSigs) { await processNewSignal(sig); found++; }
    }));
    results.forEach((r, idx) => {
      if (r.status === 'rejected')
        console.warn(`[15m-fast] ${batch[idx].id}:`, r.reason?.message);
    });
    if (i + BATCH < toScan.length) await new Promise(r => setTimeout(r, 300));
  }
  if (found) console.log(`[15m-fast] ✦ ${found} new signal(s) detected`);
}

// ═══════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════

// Chart data proxy — browser fetches from here, no CORS issues
app.get('/api/klines', async (req, res) => {
  const { symbol = '', interval = '' } = req.query;
  if (!VALID_SYMBOL.test(symbol))    return res.status(400).json({ error: 'Invalid symbol' });
  if (!VALID_INTERVAL.has(interval)) return res.status(400).json({ error: 'Invalid interval' });
  const limit = sanitizeLimit(req.query.limit);
  try {
    const data = await getLiveKlines(symbol, interval, limit);
    res.json(data);
  } catch {
    res.status(502).json({ error: 'Data fetch failed' });
  }
});

app.get('/api/forex/klines', async (req, res) => {
  const { symbol = '', interval = '' } = req.query;
  if (!VALID_SYMBOL.test(symbol))    return res.status(400).json({ error: 'Invalid symbol' });
  if (!VALID_INTERVAL.has(interval)) return res.status(400).json({ error: 'Invalid interval' });
  const limit = sanitizeLimit(req.query.limit);
  try {
    const data = await getForexKlines(symbol, interval, limit);
    res.json(data);
  } catch {
    res.status(502).json({ error: 'Data fetch failed' });
  }
});

app.get('/api/ticker', async (req, res) => {
  const { symbol = '' } = req.query;
  if (!VALID_SYMBOL.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  try {
    const data = await getLiveTicker(symbol);
    res.json(data);
  } catch {
    res.status(502).json({ error: 'Ticker fetch failed' });
  }
});

app.get('/api/signals', (req, res) => {
  res.json(db.getActiveSignals.all());
});

app.get('/api/journal', (req, res) => {
  res.json(db.getJournal.all());
});

app.delete('/api/journal', (req, res) => {
  try {
    db.clearJournal.run();
    broadcast({ type: 'journal_update', data: [] });
    broadcast({ type: 'summary_init', data: summaryPayload() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats', (req, res) => {
  res.json(db.getPatternStats.all());
});

app.get('/api/backtest/results', (req, res) => {
  res.json(db.getBacktestResults.all());
});

app.get('/api/instruments', (req, res) => {
  res.json({ crypto: CRYPTO_PAIRS, forex: FOREX_PAIRS });
});

app.get('/api/sessions', (req, res) => {
  res.json({
    active:  engine.getMarketSessions(),
    bonus:   engine.getSessionBonus(),
    utcHour: new Date().getUTCHours(),
  });
});

// Health endpoint — required for Render/Docker deploy health checks
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), ts: Date.now() });
});

// ── CSV export helpers ────────────────────────────────────────────────
function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape  = v => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => escape(row[h])).join(','));
  return lines.join('\r\n');
}

app.get('/api/export/journal', (req, res) => {
  const rows = db.getFullJournal.all();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="apex_journal.csv"');
  res.send(toCSV(rows));
});

app.get('/api/export/signals', (req, res) => {
  const rows = db.getAllSignals.all();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="apex_signals.csv"');
  res.send(toCSV(rows));
});

app.get('/api/export/backtest', (req, res) => {
  const rows = db.getBacktestResults.all();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="apex_backtest.csv"');
  res.send(toCSV(rows));
});

// Trigger a full backtest run (can take several minutes)
let _backtestRunning = false;
let _backtestLastRun = 0;
app.post('/api/backtest/run', async (req, res) => {
  if (_backtestRunning) return res.status(409).json({ error: 'Backtest already running' });
  const sinceLastRun = Date.now() - _backtestLastRun;
  if (sinceLastRun < BACKTEST_COOLDOWN_MS) {
    const waitSec = Math.ceil((BACKTEST_COOLDOWN_MS - sinceLastRun) / 1000);
    return res.status(429).json({ error: `Cooldown: wait ${waitSec}s before next run` });
  }
  _backtestRunning = true;
  _backtestLastRun = Date.now();
  res.json({ started: true, message: 'Backtest started. Results will appear in the Backtest tab when complete.' });
  const pairs = req.body.pairs || CRYPTO_PAIRS;
  const tfs   = req.body.timeframes || ['1h', '4h'];
  try {
    await runBacktest(pairs, tfs, (n, t, label) => {
      broadcast({ type: 'backtest_progress', done: n, total: t, label });
    });
    const results = db.getBacktestResults.all();
    broadcast({ type: 'backtest_results', data: results });
    broadcast({ type: 'backtest_done' });
  } catch (e) {
    console.error('[Backtest]', e);
    broadcast({ type: 'backtest_error', message: e.message });
  } finally {
    _backtestRunning = false;
  }
});

// ═══════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════

async function start() {
  try {
    const stats = db.getPatternStats.all();
    engine.setPatternWinRates(stats);
    console.log(`[Boot] Loaded ${stats.length} pattern stats`);
  } catch (e) {
    console.warn('[Boot] Could not load pattern stats:', e.message);
  }

  try {
    const expired = db.expireOldSignals.run(Date.now());
    if (expired.changes > 0) console.log(`[Boot] Expired ${expired.changes} stale time-based signals`);
  } catch (e) {
    console.warn('[Boot] Could not expire stale signals:', e.message);
  }

  // Immediately check pending signals against current price at boot
  setTimeout(async () => {
    const pending = db.getActiveSignals.all().filter(s => s.status === 'pending');
    if (!pending.length) return;
    const pairIds = [...new Set(pending.map(s => s.pair_id))];
    for (const pairId of pairIds) {
      try {
        const ticker = await getLiveTicker(pairId);
        const price  = +ticker.lastPrice;
        for (const sig of pending.filter(s => s.pair_id === pairId)) {
          const update = engine.updateSignalOnPrice(sig, price);
          if (update) {
            handleSignalUpdate(sig, update);
            console.log(`[Boot] Signal ${sig.id} → ${update.status} (price: ${price}, entry: ${sig.entry})`);
          }
        }
      } catch { }
    }
  }, 1500);

  // Scan intervals
  setInterval(scanCryptoSignals,  4 * 60 * 1000); // full parallel scan every 4 min
  setInterval(scan15mFast,           90 * 1000);   // 15m fast scan every 90 s
  setInterval(scanForexSignals,   5 * 60 * 1000);  // scan one forex pair every 5 min
  setInterval(updateCryptoPrices,    15 * 1000);   // price refresh every 15 s
  setInterval(updateForexPrices,     60 * 1000);   // forex prices every 60 s
  setInterval(broadcastSessions,     60 * 1000);   // session update every minute

  // Staggered boot scans — prices first (lightweight), then full scan
  setTimeout(updateCryptoPrices, 5_000);
  setTimeout(scanCryptoSignals, 20_000);
  setTimeout(scan15mFast,       35_000);

  server.listen(PORT, HOST, () => {
    console.log(`\n🔺 APEX TERMINAL v3 running on http://${HOST}:${PORT}`);
    console.log(`   Crypto pairs: ${CRYPTO_PAIRS.length}  |  Forex pairs: ${FOREX_PAIRS.length}`);
    console.log(`   Telegram: ${process.env.TELEGRAM_TOKEN ? '✓ configured' : '✗ not set (add to .env)'}`);
    console.log(`   Twelve Data: ${TWELVE_KEY && TWELVE_KEY !== 'your_twelve_data_key_here' ? '✓ configured' : '✗ not set (forex disabled)'}\n`);
  });
}

// ═══════════════════════════════════════════════════════════════════
// CRASH GUARDS — a long-running market server must survive transient
// network failures. Unhandled rejections / exceptions are logged and
// swallowed so the process auto-recovers instead of exiting.
// ═══════════════════════════════════════════════════════════════════
process.on('unhandledRejection', reason => {
  console.warn('[unhandledRejection]', reason?.message ?? reason);
});
process.on('uncaughtException', err => {
  console.warn('[uncaughtException]', err?.message ?? err);
});

start().catch(console.error);
