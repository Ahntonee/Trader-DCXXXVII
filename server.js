'use strict';
// config.js calls require('dotenv').config() — must be first so env vars
// are loaded before any other module reads process.env.
const {
  PORT, HOST, TWELVE_KEY, VALID_SYMBOL, VALID_INTERVAL, sanitizeLimit,
  CRYPTO_PAIRS, FOREX_PAIRS, TIMEFRAMES, MTF_MAP, CANDLE_LIMIT,
  MAX_CORRELATED, BACKTEST_COOLDOWN_MS, SIGNAL_WHITELIST,
} = require('./config');
const {
  getLiveKlines, getLiveTicker, getForexKlines, getForexPrice,
} = require('./data-sources');

const express           = require('express');
const http              = require('http');
const { WebSocketServer } = require('ws');
const path              = require('path');
const fs                = require('fs');
const db                = require('./db');
const engine            = require('./signal-engine');
const tg                = require('./telegram');
const { runBacktest }   = require('./backtester');
const portfolio         = require('./portfolio');
const { requireAdmin, originAllowed, rateLimit, securityHeaders } = require('./security');
const audit             = require('./audit');
const crypto            = require('crypto');

// Candle cache for structure-based trailing stop — keyed by pairId+tf
const _candleCache = {};

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({
  server,
  maxPayload: 1024, // clients never send us anything meaningful
  // Block cross-site WebSocket hijacking: browsers must connect from our own origin.
  verifyClient: ({ origin, req }) => originAllowed(origin, req.headers.host),
});

app.disable('x-powered-by');
// Behind Render/other reverse proxy: trust one hop so req.ip is the real client.
if (process.env.TRUST_PROXY || process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', rateLimit({ windowMs: 60_000, max: 240 }));
// Tighter cap on admin/expensive routes (auth failures count too).
const adminLimiter = rateLimit({ windowMs: 60_000, max: 10 });
const adminOnly    = [adminLimiter, requireAdmin];

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
  const yestStart  = todayStart - 86_400_000;
  const t = db.getTodaySummary.get({ todayStart, yestStart });
  return { ...s, fired_today: t.fired_today || 0, expired_today: t.expired_today || 0,
                 fired_yesterday: t.fired_yesterday || 0, expired_yesterday: t.expired_yesterday || 0 };
}

function broadcastPortfolio() {
  broadcast({ type: 'portfolio_update', data: portfolio.portfolioPayload() });
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
    if (_backtestRunning)  ws.send(JSON.stringify({ type: 'backtest_running' }));
    ws.send(JSON.stringify({ type: 'backtest_meta', data: db.getBacktestMeta.get() }));
    ws.send(JSON.stringify({ type: 'portfolio_update', data: portfolio.portfolioPayload() }));
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
  if (!SIGNAL_WHITELIST.has(`${sig.pattern}|${sig.tf}`)) return;
  try {
    const allActive = db.getActiveSignals.all();

    // ── Exact duplicate guard ─────────────────────────────────────
    // Same pair + same timeframe + same direction already active → skip.
    const exactDupe = allActive.find(s =>
      s.pair_id === sig.pair_id &&
      s.tf      === sig.tf      &&
      s.dir     === sig.dir     &&
      ['pending', 'entered', 'tp1_hit'].includes(s.status)
    );
    if (exactDupe) return;

    // ── Correlation cap ───────────────────────────────────────────
    // Count active signals in the same direction (pending or entered).
    // MTF stacks on the SAME pair are exempt — they are one trade.
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
    audit.append('signal_created', 'system', {
      id: sig.id, pair: sig.pair_id, tf: sig.tf, dir: sig.dir, pattern: sig.pattern,
      entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2 ?? null,
      confidence: sig.confidence, tier: sig.tier ?? null, htf_bias: sig.htf_bias ?? 'neutral',
      adx: sig.adx ?? null, mtf_stack: !!sig.mtf_stack,
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
    audit.append(`signal_${updates.status}`, 'system', {
      id: sig.id, pair: sig.pair_id, tf: sig.tf, dir: sig.dir,
      entry_price: updates.entry_price ?? sig.entry_price ?? null,
      close_price: updates.close_price ?? null, r_mult: updates.r_mult ?? null,
    });

    // ── ENTRY: open paper trade ───────────────────────────────────────
    if (updates.status === 'entered') {
      const pData = portfolio.openTrade(sig, updates.entry_price ?? sig.entry);
      if (pData) broadcast({ type: 'portfolio_update', data: pData });
    }

    // ── ACCOUNTING MODEL (single source of truth) ───────────────────
    // A trade is ONE position, closed ONCE:
    //   • TP1 hit  → whole position closed at +1R  (journal win, stat win, paper trade closed)
    //   • SL hit before TP1 → closed at -1R         (journal loss, stat loss, paper trade closed)
    // After TP1 the signal keeps being tracked as an informational "runner"
    // (trailing stop → TP2 or stop-out). Runner outcomes update the signal
    // status and send an alert but NEVER write journal rows, pattern stats
    // or portfolio P&L — that would count the same trade twice.

    // ── TP1 HIT: close the position at +1.0R ─────────────────────────
    if (updates.status === 'tp1_hit') {
      const entryPx   = updates.entry_price ?? sig.entry_price ?? sig.entry;
      const exitPrice = updates.close_price || sig.tp1;
      const pnlPct = entryPx > 0 ? ((exitPrice - entryPx) / entryPx * (sig.dir === 'long' ? 100 : -100)) : 0;

      let pd1 = null;
      db.withTransaction(() => {
        // Runner stop starts at the TP1 price (runner can't turn a banked win into a loss).
        db.updateSignalSL.run({ id: sig.id, sl: sig.tp1 });
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
        pd1 = portfolio.hitTP1(sig.id);
      });
      broadcast({ type: 'signal_update', id: sig.id, updates: { sl: sig.tp1 } });
      broadcast({ type: 'journal_update', data: db.getJournal.all() });
      broadcast({ type: 'summary_init', data: summaryPayload() });
      tg.sendMessage(tg.formatTPHit(sig, 'tp1'));
      console.log(`[TP1] ${sig.sym} — position closed at +1.0R; runner stop moved to TP1 (${sig.tp1})`);
      if (pd1) broadcast({ type: 'portfolio_update', data: pd1 });
    }

    // ── RUNNER FINISH (after TP1): informational only ─────────────────
    if (sig.status === 'tp1_hit' && ['tp2_hit', 'sl_hit'].includes(updates.status)) {
      if (updates.status === 'tp2_hit') {
        tg.sendMessage(tg.formatTPHit(sig, 'tp2'));
        console.log(`[Runner] ${sig.sym} — reached TP2 (not counted: position already closed at TP1)`);
      } else {
        tg.sendMessage(`🔒 ${sig.sym} ${sig.tf} — runner stopped out at/above TP1 (trade already closed at +1R)`);
        console.log(`[Runner] ${sig.sym} — runner stopped (not counted: position already closed at TP1)`);
      }
    }
    // ── STOP LOSS before TP1: full -1R loss ───────────────────────────
    else if (updates.status === 'sl_hit' || (updates.status === 'tp2_hit' && sig.status !== 'tp1_hit')) {
      // tp2_hit without a prior tp1_hit means price gapped through TP1 in one
      // tick; the position still closes at TP1 (+1R), never at TP2.
      const gappedThroughTP1 = updates.status === 'tp2_hit';
      const entryPx   = sig.entry_price ?? sig.entry;
      const exitPrice = gappedThroughTP1 ? sig.tp1 : (updates.close_price ?? sig.sl);
      const rMult     = gappedThroughTP1 ? 1.0 : -1;
      const outcome   = gappedThroughTP1 ? 'tp1' : 'sl';
      const pnlPct = entryPx > 0
        ? ((exitPrice - entryPx) / entryPx * (sig.dir === 'long' ? 100 : -100))
        : 0;

      let pdClose = null;
      db.withTransaction(() => {
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
          wins: rMult > 0 ? 1 : 0, losses: rMult < 0 ? 1 : 0,
          total_r: rMult, count: 1,
          win_rate: rMult > 0 ? 1 : 0, avg_r: rMult,
        });
        pdClose = gappedThroughTP1
          ? portfolio.hitTP1(sig.id)
          : portfolio.closeTrade(sig.id, rMult, outcome);
      });

      broadcast({ type: 'journal_update', data: db.getJournal.all() });
      broadcast({ type: 'summary_init', data: summaryPayload() });
      if (pdClose) broadcast({ type: 'portfolio_update', data: pdClose });
      tg.sendMessage(gappedThroughTP1 ? tg.formatTPHit(sig, 'tp1') : tg.formatSLHit(sig));
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
    audit.append('signal_expired', 'system', { id: sig.id, reason: 'post-NY blackout' });
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

app.delete('/api/journal', ...adminOnly, (req, res) => {
  try {
    // Log BEFORE destroying: the audit trail must survive the action it records.
    audit.append('admin_journal_cleared', 'admin', { journal_rows: db.getFullJournal.all().length });
    db.clearJournal.run();
    broadcast({ type: 'journal_update', data: [] });
    broadcast({ type: 'summary_init', data: summaryPayload() });
    res.json({ ok: true });
  } catch (e) {
    console.error('[journal clear]', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/stats', (req, res) => {
  res.json(db.getPatternStats.all());
});

app.get('/api/backtest/results', (req, res) => {
  res.json(db.getBacktestResults.all());
});

app.get('/api/backtest/meta', (req, res) => {
  res.json(db.getBacktestMeta.get() || null);
});

app.get('/api/trade-flow', (req, res) => {
  res.json(db.getTradeFlow.all());
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

// ── Accountability API (public, read-only) ─────────────────────────────
// Anyone can pull the decision log and re-verify the hash chain themselves.
app.use('/v1', rateLimit({ windowMs: 60_000, max: 120 }));
app.get('/v1/audit', (req, res) => {
  res.json({ head: audit.head(), entries: audit.list(+req.query.after || 0, +req.query.limit || 100) });
});
app.get('/v1/audit/verify', (req, res) => {
  const from = Math.max(1, parseInt(req.query.from, 10) || 1);
  const to   = parseInt(req.query.to, 10) || Number.MAX_SAFE_INTEGER;
  const r = audit.verify(from, to);
  res.status(r.ok ? 200 : 409).json(r);
});
app.get('/v1/audit/anchors', (req, res) => res.json(audit.anchors()));
app.get('/v1/audit/anchors/:id/verify', (req, res) => {
  const r = audit.verifyAnchor(parseInt(req.params.id, 10));
  res.status(r.ok ? 200 : 409).json(r);
});
// Admin: summarise new log rows into a Merkle checkpoint ready to anchor on-chain.
app.post('/v1/audit/checkpoint', ...adminOnly, (req, res) => {
  try {
    const cp = audit.createCheckpoint();
    if (!cp) return res.json({ created: false, message: 'No new entries since last checkpoint' });
    audit.append('audit_checkpoint', 'admin', { anchor_id: cp.id, from: cp.from_seq, to: cp.to_seq, root: cp.root });
    res.json({ created: true, ...cp });
  } catch (e) { res.status(409).json({ error: e.message }); }
});
// Admin: attach the on-chain transaction hash once the root has been submitted.
app.post('/v1/audit/anchors/:id/tx', ...adminOnly, (req, res) => {
  const tx = String(req.body?.tx_hash || '');
  if (!/^[0-9a-fA-F]{64}$/.test(tx)) return res.status(400).json({ error: 'tx_hash must be 64 hex chars' });
  audit.recordAnchorTx(parseInt(req.params.id, 10), tx.toLowerCase(), 'concordium-testnet');
  res.json({ ok: true });
});

// Agent Card — served as the EXACT bytes on disk. The on-chain `metadata_hash`
// is the SHA-256 of these bytes, so never re-serialise or transform them.
const AGENT_CARD_PATH = path.join(__dirname, 'agent-card.json');
function sendAgentCard(req, res) {
  try {
    const bytes = fs.readFileSync(AGENT_CARD_PATH);
    res.set('Content-Type', 'application/json; charset=utf-8').set('Cache-Control', 'public, max-age=300').send(bytes);
  } catch { res.status(404).json({ error: 'Agent card not published yet' }); }
}
app.get('/.well-known/agent-card.json', sendAgentCard);
app.get('/v1/agent-card/hash', (req, res) => {
  try { res.json({ sha256: crypto.createHash('sha256').update(fs.readFileSync(AGENT_CARD_PATH)).digest('hex') }); }
  catch { res.status(404).json({ error: 'Agent card not published yet' }); }
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

// ── Portfolio endpoints ───────────────────────────────────────────────────
app.get('/api/portfolio', (req, res) => res.json(portfolio.portfolioPayload()));

app.post('/api/portfolio/reset', ...adminOnly, (req, res) => {
  const { starting = 100, risk_pct = 1.0 } = req.body || {};
  const start = Number(starting), risk = Number(risk_pct);
  if (!Number.isFinite(start) || start < 1 || start > 10_000_000)
    return res.status(400).json({ error: 'starting must be between 1 and 10,000,000' });
  if (!Number.isFinite(risk) || risk < 0.1 || risk > 5)
    return res.status(400).json({ error: 'risk_pct must be between 0.1 and 5' });
  audit.append('admin_portfolio_reset', 'admin', { starting: start, risk_pct: risk });
  const data = portfolio.resetPortfolio(start, risk);
  if (data) { broadcast({ type: 'portfolio_update', data }); res.json({ ok: true, data }); }
  else res.status(500).json({ error: 'Reset failed' });
});

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
app.post('/api/backtest/run', ...adminOnly, async (req, res) => {
  // Validate the request against server-side allow-lists BEFORE touching state.
  // Pairs may be sent as ids or {id} objects; anything unknown is ignored.
  const body = req.body || {};
  let pairs = CRYPTO_PAIRS;
  if (body.pairs !== undefined) {
    if (!Array.isArray(body.pairs)) return res.status(400).json({ error: 'pairs must be an array' });
    const wanted = new Set(body.pairs.map(p => (p && typeof p === 'object' ? p.id : p)));
    pairs = CRYPTO_PAIRS.filter(p => wanted.has(p.id));
    if (!pairs.length) return res.status(400).json({ error: 'No valid pairs supplied' });
  }
  let tfs = ['1h', '4h'];
  if (body.timeframes !== undefined) {
    if (!Array.isArray(body.timeframes)) return res.status(400).json({ error: 'timeframes must be an array' });
    tfs = TIMEFRAMES.filter(t => body.timeframes.includes(t));
    if (!tfs.length) return res.status(400).json({ error: `timeframes must be among ${TIMEFRAMES.join(', ')}` });
  }

  if (_backtestRunning) return res.status(409).json({ error: 'Backtest already running' });
  const sinceLastRun = Date.now() - _backtestLastRun;
  if (sinceLastRun < BACKTEST_COOLDOWN_MS) {
    const waitSec = Math.ceil((BACKTEST_COOLDOWN_MS - sinceLastRun) / 1000);
    return res.status(429).json({ error: `Cooldown: wait ${waitSec}s before next run` });
  }
  _backtestRunning = true;
  _backtestLastRun = Date.now();
  audit.append('admin_backtest_started', 'admin', { pairs: pairs.length, timeframes: tfs });
  db.upsertBacktestMeta.run({ last_run_at: _backtestLastRun, status: 'running', message: null, row_count: 0 });
  broadcast({ type: 'backtest_meta', data: db.getBacktestMeta.get() });
  res.json({ started: true, message: 'Backtest started. Results will appear in the Backtest tab when complete.' });
  try {
    await runBacktest(pairs, tfs, (n, t, label) => {
      broadcast({ type: 'backtest_progress', done: n, total: t, label });
    });
    const results = db.getBacktestResults.all();
    db.upsertBacktestMeta.run({ last_run_at: _backtestLastRun, status: 'success', message: null, row_count: results.length });
    broadcast({ type: 'backtest_results', data: results });
    broadcast({ type: 'backtest_meta', data: db.getBacktestMeta.get() });
    broadcast({ type: 'backtest_done' });
  } catch (e) {
    console.error('[Backtest]', e);
    db.upsertBacktestMeta.run({ last_run_at: Date.now(), status: 'failed', message: 'Backtest failed — see server logs', row_count: 0 });
    broadcast({ type: 'backtest_meta', data: db.getBacktestMeta.get() });
    broadcast({ type: 'backtest_error', message: 'Backtest failed — see server logs' });
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

  // Record exactly which build + rule-set is making decisions from now on.
  try {
    const cfg = require('./config');
    audit.append('agent_start', 'system', {
      version: require('./package.json').version,
      node: process.version,
      signal_whitelist_sha256: crypto.createHash('sha256').update([...cfg.SIGNAL_WHITELIST].sort().join('\n')).digest('hex'),
      whitelist: [...cfg.SIGNAL_WHITELIST].sort(),
      pairs: cfg.CRYPTO_PAIRS.length,
      max_correlated: cfg.MAX_CORRELATED,
    });
    const v = audit.verify();
    if (!v.ok) console.error(`[Audit] ⚠ CHAIN BROKEN at seq ${v.brokenAt}: ${v.reason}`);
    else console.log(`[Audit] chain OK — ${v.checked} entries`);
  } catch (e) { console.error('[Audit] boot check failed:', e.message); }

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
// An uncaught exception leaves the process in an unknown state (half-applied
// DB writes, dangling timers). Log, shut down cleanly and let the supervisor
// (Render / Docker restart policy) bring up a fresh process.
process.on('uncaughtException', err => {
  console.error('[uncaughtException] fatal:', err?.stack ?? err);
  shutdown(1);
});

let _shuttingDown = false;
function shutdown(code = 0) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log('[Shutdown] closing server…');
  const force = setTimeout(() => process.exit(code || 1), 8000);
  force.unref();
  try { wss.clients.forEach(c => c.terminate()); } catch { }
  server.close(() => {
    try { db.db.close(); } catch { }
    process.exit(code);
  });
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT',  () => shutdown(0));

start().catch(console.error);
