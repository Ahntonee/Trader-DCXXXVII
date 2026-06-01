'use strict';
require('dotenv').config();

const express  = require('express');
const http     = require('http');
const { WebSocketServer } = require('ws');
const fetch    = require('node-fetch');
const path     = require('path');
const db       = require('./db');
const engine   = require('./signal-engine');
const tg       = require('./telegram');
const { runBacktest } = require('./backtester');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const TWELVE_KEY = process.env.TWELVE_DATA_KEY || '';

// ═══════════════════════════════════════════════════════════════════
// INSTRUMENTS
// ═══════════════════════════════════════════════════════════════════

const CRYPTO_PAIRS = [
  // ── Core large-caps ───────────────────────────────────────────
  { id: 'BTCUSDT',  sym: 'BTC',  dec: 2,  minMove: 0.01    },
  { id: 'ETHUSDT',  sym: 'ETH',  dec: 2,  minMove: 0.01    },
  { id: 'SOLUSDT',  sym: 'SOL',  dec: 3,  minMove: 0.001   },
  { id: 'BNBUSDT',  sym: 'BNB',  dec: 2,  minMove: 0.01    },
  { id: 'XRPUSDT',  sym: 'XRP',  dec: 4,  minMove: 0.0001  },
  { id: 'ADAUSDT',  sym: 'ADA',  dec: 4,  minMove: 0.0001  },
  { id: 'DOGEUSDT', sym: 'DOGE', dec: 5,  minMove: 0.00001 },
  { id: 'AVAXUSDT', sym: 'AVAX', dec: 3,  minMove: 0.001   },
  { id: 'TRXUSDT',  sym: 'TRX',  dec: 5,  minMove: 0.00001 },
  { id: 'TONUSDT',  sym: 'TON',  dec: 4,  minMove: 0.0001  },
  // ── High liquidity mid-caps ───────────────────────────────────
  { id: 'HYPEUSDT', sym: 'HYPE', dec: 3,  minMove: 0.001   },
  { id: 'SUIUSDT',  sym: 'SUI',  dec: 4,  minMove: 0.0001  },
  { id: 'LINKUSDT', sym: 'LINK', dec: 3,  minMove: 0.001   },
  { id: 'DOTUSDT',  sym: 'DOT',  dec: 3,  minMove: 0.001   },
  { id: 'LTCUSDT',  sym: 'LTC',  dec: 2,  minMove: 0.01    },
  { id: 'ONDOUSDT', sym: 'ONDO', dec: 4,  minMove: 0.0001  },
  // ── High-volume meme / narrative tokens ───────────────────────
  { id: 'PEPEUSDT', sym: 'PEPE', dec: 8,  minMove: 0.00000001 },
  { id: 'WIFUSDT',  sym: 'WIF',  dec: 4,  minMove: 0.0001  },
];

const FOREX_PAIRS = [
  { id: 'XAU/USD', sym: 'GOLD', dec: 2 },
  { id: 'XAG/USD', sym: 'SILVER', dec: 3 },
];

const TIMEFRAMES = ['15m', '1h', '4h', '1d'];
const MTF_MAP    = { '15m': '1h', '1h': '4h', '4h': '1d', '1d': '1d' };
const BINANCE    = 'https://api.binance.com';
const BYBIT      = 'https://api.bybit.com';
const BYBIT_TF   = { '15m':'15','1h':'60','4h':'240','1d':'D' };
const TWELVE     = 'https://api.twelvedata.com';
const CC_BASE    = 'https://min-api.cryptocompare.com/data/v2';
const CC_TF      = { '15m':['histominute',15],'1h':['histohour',1],'4h':['histohour',4],'1d':['histoday',1] };
const YAHOO      = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YF_INT     = { '15m':'15m','1h':'1h','4h':'1h','1d':'1d' };
const YF_RANGE   = { '15m':'5d','1h':'30d','4h':'120d','1d':'200d' };
const YF_AGG     = { '4h':4 };

function ccSym(symbol) { return symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol; }
function yfSym(symbol) { return symbol.endsWith('USDT') ? `${symbol.slice(0,-4)}-USD` : symbol; }
function aggregateCandles(candles, factor) {
  if (!factor || factor <= 1) return candles;
  const out = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    out.push({ time: chunk[0].time, open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)), low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length-1].close, volume: chunk.reduce((s,c) => s + c.volume, 0) });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// DATA FETCHING (Binance → Bybit → CryptoCompare fallback chain)
// ═══════════════════════════════════════════════════════════════════

const CANDLE_LIMIT = { '15m': 200, '1h': 200, '4h': 150, '1d': 100 };

async function getBinanceKlines(symbol, interval, limit) {
  // 1. Binance
  try {
    const url = `${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    return data.map(c => ({ time: Math.floor(c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
  } catch { }

  // 2. Bybit
  try {
    const btf = BYBIT_TF[interval] || '60';
    const url = `${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=${btf}&limit=${limit}`;
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) throw new Error(`Bybit ${res.status}`);
    const data = await res.json();
    if (data.retCode !== 0) throw new Error(`Bybit: ${data.retMsg}`);
    const candles = [...(data.result?.list || [])].reverse()
      .map(c => ({ time: Math.floor(+c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
    if (candles.length) return candles;
  } catch { }

  // 3. CryptoCompare
  try {
    const [ep, agg] = CC_TF[interval] || ['histohour', 1];
    const fsym = ccSym(symbol);
    const url = `${CC_BASE}/${ep}?fsym=${fsym}&tsym=USDT&limit=${limit}&aggregate=${agg}`;
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) throw new Error(`CC ${res.status}`);
    const data = await res.json();
    if (data.Response !== 'Success') throw new Error(`CC: ${data.Message}`);
    const cc = (data.Data?.Data || []).filter(c => c.close > 0)
      .map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volumefrom }));
    if (cc.length) return cc;
  } catch { }

  // 4. Yahoo Finance
  const yf = yfSym(symbol);
  const yfRes = await fetch(
    `${YAHOO}/${yf}?interval=${YF_INT[interval]||'1h'}&range=${YF_RANGE[interval]||'30d'}&includePrePost=false`,
    { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!yfRes.ok) throw new Error(`YF ${yfRes.status}`);
  const yfData = await yfRes.json();
  const yfR = yfData.chart?.result?.[0];
  if (!yfR) throw new Error('YF: no data');
  const ts = yfR.timestamp || [], q = yfR.indicators?.quote?.[0] || {};
  const raw = ts.map((t, i) => ({ time: t, open: q.open?.[i]||0, high: q.high?.[i]||0,
    low: q.low?.[i]||0, close: q.close?.[i]||0, volume: q.volume?.[i]||0 })).filter(c => c.close > 0);
  return aggregateCandles(raw, YF_AGG[interval] || 1).slice(-limit);
}

async function getBinanceTicker(symbol) {
  // 1. Binance
  try {
    const res = await fetch(`${BINANCE}/api/v3/ticker/24hr?symbol=${symbol}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`Ticker ${res.status}`);
    return res.json();
  } catch { }

  // 2. Bybit
  try {
    const res = await fetch(`${BYBIT}/v5/market/tickers?category=spot&symbol=${symbol}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`Bybit ticker ${res.status}`);
    const data = await res.json();
    const t = data.result?.list?.[0];
    if (t) return { lastPrice: t.lastPrice, priceChangePercent: (+t.price24hPcnt * 100).toFixed(2) };
  } catch { }

  // 3. CryptoCompare
  try {
    const fsym = ccSym(symbol);
    const res = await fetch(`https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${fsym}&tsyms=USDT`, { timeout: 5000 });
    if (!res.ok) throw new Error(`CC ticker ${res.status}`);
    const data = await res.json();
    const info = data.RAW?.[fsym]?.USDT;
    if (info) return { lastPrice: info.PRICE.toString(), priceChangePercent: info.CHANGEPCT24HOUR.toFixed(2) };
  } catch { }

  // 4. Yahoo Finance
  const yf = yfSym(symbol);
  const yfRes = await fetch(`${YAHOO}/${yf}?interval=1d&range=2d`, { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!yfRes.ok) throw new Error(`YF ticker ${yfRes.status}`);
  const yfData = await yfRes.json();
  const meta = yfData.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error('YF: no price');
  return { lastPrice: meta.regularMarketPrice.toString(), priceChangePercent: (meta.regularMarketChangePercent || 0).toFixed(2) };
}

async function getForexKlines(symbol, interval, limit = 200) {
  if (!TWELVE_KEY || TWELVE_KEY === 'your_twelve_data_key_here') return [];
  const tfMap = { '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day' };
  const url = `${TWELVE}/time_series?symbol=${symbol}&interval=${tfMap[interval]||'1h'}&outputsize=${limit}&apikey=${TWELVE_KEY}`;
  try {
    const res = await fetch(url, { timeout: 10000 });
    const data = await res.json();
    if (!data.values) return [];
    return data.values.reverse().map(c => ({
      time: Math.floor(new Date(c.datetime).getTime() / 1000),
      open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +(c.volume || 0),
    }));
  } catch { return []; }
}

async function getForexPrice(symbol) {
  if (!TWELVE_KEY || TWELVE_KEY === 'your_twelve_data_key_here') return null;
  try {
    const res = await fetch(`${TWELVE}/price?symbol=${symbol}&apikey=${TWELVE_KEY}`, { timeout: 5000 });
    const data = await res.json();
    return data.price ? +data.price : null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// WEBSOCKET BROADCAST
// ═══════════════════════════════════════════════════════════════════

function broadcast(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(str); });
}

wss.on('connection', ws => {
  // Send current active signals on connect
  try {
    const active = db.getActiveSignals.all();
    ws.send(JSON.stringify({ type: 'signals_init', data: active }));
    const journal = db.getJournal.all();
    ws.send(JSON.stringify({ type: 'journal_init', data: journal }));
    const stats = db.getPatternStats.all();
    ws.send(JSON.stringify({ type: 'stats_init', data: stats }));
    const btResults = db.getBacktestResults.all();
    if (btResults.length) ws.send(JSON.stringify({ type: 'backtest_results', data: btResults }));
    ws.send(JSON.stringify({ type: 'summary_init', data: db.getSignalSummary.get() }));
  } catch (e) { console.warn('WS init error:', e.message); }
});

// ═══════════════════════════════════════════════════════════════════
// SIGNAL PROCESSING
// ═══════════════════════════════════════════════════════════════════

async function processNewSignal(sig) {
  try {
    db.insertSignal.run({
      ...sig,
      candle_pattern: sig.candle_pattern || null,
      htf_bias: sig.htf_bias || 'neutral',
      adx: sig.adx || null,
    });
    broadcast({ type: 'new_signal', data: sig });
    broadcast({ type: 'summary_init', data: db.getSignalSummary.get() });
    const tgMsg = tg.formatSignal(sig);
    await tg.sendMessage(tgMsg);
    console.log(`[SIGNAL] ${sig.dir.toUpperCase()} ${sig.sym} ${sig.tf} | ${sig.pattern} | Conf: ${sig.confidence}% | ADX: ${sig.adx}`);
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

    // Log to journal on close
    if (['tp1_hit', 'tp2_hit', 'sl_hit'].includes(updates.status)) {
      const outcome = updates.status.replace('_hit', '');
      const entryPrice = updates.entry_price || sig.entry_price || sig.entry;
      const exitPrice  = updates.close_price || (updates.status === 'sl_hit' ? sig.sl : updates.status === 'tp1_hit' ? sig.tp1 : sig.tp2);
      const riskPx  = Math.abs(entryPrice - sig.sl);
      const rMult   = riskPx > 0 ? (updates.r_mult || ((exitPrice - entryPrice) * (sig.dir === 'long' ? 1 : -1)) / riskPx) : 0;
      const pnlPct  = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice * (sig.dir === 'long' ? 100 : -100)) : 0;
      db.insertJournal.run({
        signal_id: sig.id, sym: sig.sym, tf: sig.tf, dir: sig.dir,
        pattern: sig.pattern, htf_bias: sig.htf_bias, entry: entryPrice,
        exit_price: exitPrice, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
        outcome, r_mult: +rMult.toFixed(3), pnl_pct: +pnlPct.toFixed(3),
        confidence: sig.confidence, opened_at: sig.entered_at || sig.detected_at,
        closed_at: updates.closed_at, date: new Date().toISOString().slice(0,10),
      });
      db.upsertPatternStat.run({
        pattern: sig.pattern, tf: sig.tf, asset_class: sig.asset_class || 'crypto',
        wins: ['tp1','tp2'].includes(outcome) ? 1 : 0,
        losses: outcome === 'sl' ? 1 : 0,
        total_r: rMult, count: 1,
        win_rate: ['tp1','tp2'].includes(outcome) ? 1 : 0,
        avg_r: rMult,
      });
      broadcast({ type: 'journal_update', data: db.getJournal.all() });
      broadcast({ type: 'summary_init', data: db.getSignalSummary.get() });
      // Telegram alert
      if (updates.status === 'sl_hit') tg.sendMessage(tg.formatSLHit(sig));
      else tg.sendMessage(tg.formatTPHit(sig, outcome));
    }
  } catch (e) {
    console.warn('[handleSignalUpdate] error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// LIVE PRICE TRACKING & SIGNAL STATUS UPDATES
// ═══════════════════════════════════════════════════════════════════

const _latestPrices = {}; // pairId → price

async function updateCryptoPrices() {
  for (const pair of CRYPTO_PAIRS) {
    try {
      const ticker = await getBinanceTicker(pair.id);
      const price = +ticker.lastPrice, chg = +ticker.priceChangePercent;
      _latestPrices[pair.id] = price;
      broadcast({ type: 'price', pairId: pair.id, price, change: chg });

      // Update signal statuses
      const active = db.getActiveSignals.all().filter(s => s.pair_id === pair.id);
      for (const sig of active) {
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

let _cryptoScanIdx = 0;
async function scanCryptoSignals() {
  db.expireOldSignals.run(Date.now());
  const pair = CRYPTO_PAIRS[_cryptoScanIdx % CRYPTO_PAIRS.length];
  _cryptoScanIdx++;
  for (const tf of TIMEFRAMES) {
    try {
      const limit    = CANDLE_LIMIT[tf] || 200;
      const htfTf    = MTF_MAP[tf] || '4h';
      const htfLimit = CANDLE_LIMIT[htfTf] || 100;
      const [candles, htfCandles] = await Promise.all([
        getBinanceKlines(pair.id, tf, limit),
        getBinanceKlines(pair.id, htfTf, htfLimit),
      ]);
      const newSigs = await engine.scanPair(candles, htfCandles, pair, tf, 'crypto');
      for (const sig of newSigs) await processNewSignal(sig);
    } catch (e) {
      console.warn(`[Scan] ${pair.id} ${tf}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
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
        getForexKlines(pair.id, tf, 200),
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

// ═══════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════

// Chart data proxy — browser fetches from here, no CORS issues
app.get('/api/klines', async (req, res) => {
  const { symbol, interval, limit = 200 } = req.query;
  try {
    const data = await getBinanceKlines(symbol, interval, +limit);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/forex/klines', async (req, res) => {
  const { symbol, interval, limit = 200 } = req.query;
  try {
    const data = await getForexKlines(symbol, interval, +limit);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/ticker', async (req, res) => {
  const { symbol } = req.query;
  try {
    const data = await getBinanceTicker(symbol);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
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
    broadcast({ type: 'summary_init', data: db.getSignalSummary.get() });
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

// Trigger a full backtest run (can take several minutes)
let _backtestRunning = false;
app.post('/api/backtest/run', async (req, res) => {
  if (_backtestRunning) return res.status(409).json({ error: 'Backtest already running' });
  _backtestRunning = true;
  res.json({ started: true, message: 'Backtest started. Results will appear in the Backtest tab when complete.' });
  const pairs = req.body.pairs || CRYPTO_PAIRS.slice(0, 4); // default: BTC ETH SOL BNB
  const tfs   = req.body.timeframes || ['1h', '4h'];
  let done = 0;
  const total = pairs.length * tfs.length;
  try {
    await runBacktest(pairs, tfs, (n, t, label) => {
      done = n;
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
  // Load backtested win rates into engine memory
  try {
    const stats = db.getPatternStats.all();
    engine.setPatternWinRates(stats);
    console.log(`[Boot] Loaded ${stats.length} pattern stats`);
  } catch (e) {
    console.warn('[Boot] Could not load pattern stats:', e.message);
  }

  // Immediately expire any signals that timed out while server was offline
  try {
    const expired = db.expireOldSignals.run(Date.now());
    if (expired.changes > 0) console.log(`[Boot] Expired ${expired.changes} stale time-based signals`);
  } catch (e) {
    console.warn('[Boot] Could not expire stale signals:', e.message);
  }

  // Immediately check all pending signals against current price and expire blown ones
  setTimeout(async () => {
    const pending = db.getActiveSignals.all().filter(s => s.status === 'pending');
    if (!pending.length) return;
    const pairIds = [...new Set(pending.map(s => s.pair_id))];
    for (const pairId of pairIds) {
      try {
        const ticker = await getBinanceTicker(pairId);
        const price = +ticker.lastPrice;
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

  // Intervals
  setInterval(scanCryptoSignals, 90 * 1000);    // scan one crypto pair every 90s (cycles through all)
  setInterval(scanForexSignals,  5 * 60 * 1000); // scan one forex pair every 5min
  setInterval(updateCryptoPrices, 15 * 1000);    // price refresh every 15s
  setInterval(updateForexPrices,  60 * 1000);    // forex prices every 60s

  // Initial scans on startup
  setTimeout(scanCryptoSignals, 3000);
  setTimeout(updateCryptoPrices, 5000);

  server.listen(PORT, () => {
    console.log(`\n🔺 APEX TERMINAL v2 running on http://localhost:${PORT}`);
    console.log(`   Crypto pairs: ${CRYPTO_PAIRS.length}  |  Forex pairs: ${FOREX_PAIRS.length}`);
    console.log(`   Telegram: ${process.env.TELEGRAM_TOKEN ? '✓ configured' : '✗ not set (add to .env)'}`);
    console.log(`   Twelve Data: ${TWELVE_KEY && TWELVE_KEY !== 'your_twelve_data_key_here' ? '✓ configured' : '✗ not set (forex disabled)'}\n`);
  });
}

start().catch(console.error);
