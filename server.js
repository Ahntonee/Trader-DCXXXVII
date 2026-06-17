'use strict';
require('dotenv').config();

const express  = require('express');
const http     = require('http');
const { WebSocketServer } = require('ws');
const fetch    = require('node-fetch');
const path     = require('path');
const db       = require('./db');
const engine   = require('./signal-engine');
// Candle cache for structure-based trailing — keyed by pairId+tf
const _candleCache = {};
const tg       = require('./telegram');
const { runBacktest } = require('./backtester');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json({ limit: '16kb' })); // cap body size
app.use(express.static(path.join(__dirname, 'public')));

const PORT       = process.env.PORT || 3000;
// On Render/cloud HOST must be 0.0.0.0; for local installs keep 127.0.0.1
const HOST       = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const TWELVE_KEY = process.env.TWELVE_DATA_KEY || '';
const CC_KEY     = process.env.CRYPTOCOMPARE_KEY || ''; // free key restores CryptoCompare (now 401 without one)

// ── Input validation helpers ──────────────────────────────────────
const VALID_SYMBOL   = /^[A-Z0-9]{2,20}(\/[A-Z]{2,6})?$/; // e.g. BTCUSDT or XAU/USD
const VALID_INTERVAL = new Set(['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w']);
function sanitizeLimit(raw, def = 200, max = 500) {
  const n = parseInt(raw, 10);
  return isNaN(n) ? def : Math.min(Math.max(n, 1), max);
}

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
  { id: 'WIFUSDT',  sym: 'WIF',  dec: 4,  minMove: 0.0001  },
  { id: 'SHIBUSDT', sym: 'SHIB', dec: 8,  minMove: 0.00000001 },
  // ── Ecosystem / narrative expansion ───────────────────────────
  { id: 'NEARUSDT', sym: 'NEAR', dec: 3,  minMove: 0.001   },
  { id: 'INJUSDT',  sym: 'INJ',  dec: 3,  minMove: 0.001   },
  { id: 'OPUSDT',   sym: 'OP',   dec: 4,  minMove: 0.0001  },
  { id: 'ARBUSDT',  sym: 'ARB',  dec: 4,  minMove: 0.0001  },
  { id: 'JUPUSDT',  sym: 'JUP',  dec: 4,  minMove: 0.0001  },
  { id: 'FTMUSDT',  sym: 'FTM',  dec: 4,  minMove: 0.0001  },
  { id: 'ATOMUSDT', sym: 'ATOM', dec: 3,  minMove: 0.001   },
  { id: 'TIAUSDT',  sym: 'TIA',  dec: 3,  minMove: 0.001   },
];

const FOREX_PAIRS = [
  { id: 'XAU/USD', sym: 'GOLD', dec: 2 },
  { id: 'XAG/USD', sym: 'SILVER', dec: 3 },
];

const TIMEFRAMES = ['15m', '1h', '4h', '1d'];
const MTF_MAP    = { '15m': '1h', '1h': '4h', '4h': '1d', '1d': '1d' };
const BINANCE    = 'https://api.binance.com';   // geo-blocked in Nigeria — kept as last resort via cloud
const BYBIT      = 'https://api.bybit.com';
const BYBIT_TF   = { '15m':'15','1h':'60','4h':'240','1d':'D' };
const MEXC       = 'https://api.mexc.com';
const OKX        = 'https://www.okx.com';
const OKX_TF     = { '15m':'15m','1h':'1H','4h':'4H','1d':'1D' };
const KUCOIN     = 'https://api.kucoin.com';
const KUCOIN_TF  = { '15m':'15min','1h':'1hour','4h':'4hour','1d':'1day' };
const COINGECKO  = 'https://api.coingecko.com/api/v3';   // works in Nigeria; priority for tickers
// Symbol → CoinGecko coin-id (ticker batch + 4h OHLC fallback). Unmapped = skipped.
const CG_IDS = {
  BTC:'bitcoin', ETH:'ethereum', SOL:'solana', BNB:'binancecoin', XRP:'ripple',
  ADA:'cardano', DOGE:'dogecoin', AVAX:'avalanche-2', TRX:'tron', TON:'the-open-network',
  HYPE:'hyperliquid', SUI:'sui', LINK:'chainlink', DOT:'polkadot', LTC:'litecoin',
  ONDO:'ondo-finance', PEPE:'pepe', WIF:'dogwifcoin', NEAR:'near', INJ:'injective-protocol',
  OP:'optimism', ARB:'arbitrum', JUP:'jupiter-exchange-solana', APT:'aptos', ATOM:'cosmos', TIA:'celestia',
};
const TWELVE     = 'https://api.twelvedata.com';
const CC_BASE    = 'https://min-api.cryptocompare.com/data/v2';
const CC_TF      = { '15m':['histominute',15],'1h':['histohour',1],'4h':['histohour',4],'1d':['histoday',1] };
const YAHOO      = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YF_INT     = { '15m':'15m','1h':'1h','4h':'1h','1d':'1d' };
const YF_RANGE   = { '15m':'5d','1h':'30d','4h':'120d','1d':'200d' };
const YF_AGG     = { '4h':4 };

function ccSym(symbol)     { return symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol; }
function yfSym(symbol)     { return symbol.endsWith('USDT') ? `${symbol.slice(0,-4)}-USD` : symbol; }
function okxSym(symbol)    { return symbol.endsWith('USDT') ? symbol.slice(0,-4)+'-USDT' : symbol; }
function kucoinSym(symbol) { return symbol.endsWith('USDT') ? symbol.slice(0,-4)+'-USDT' : symbol; }
function cgId(symbol)      { return CG_IDS[ccSym(symbol)] || null; }
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

// ── Source circuit breaker ──────────────────────────────────────────
// A geo-blocked source (e.g. Binance/Bybit in some regions) wastes
// several seconds timing out on EVERY call. After 3 consecutive failures
// we skip it for a 2-min cooldown, then probe once more. This keeps a
// working source (CryptoCompare here) serving fast instead of every
// fetch dragging through dead endpoints first. Auto-recovers when a
// source comes back (e.g. on a cloud host where Binance is reachable).
const _src = {}; // name → { fails, until }
function srcSkip(name){ const s=_src[name]; return !!(s && s.until > Date.now()); }
function srcDown(name){ const s=_src[name]||(_src[name]={fails:0,until:0}); if(++s.fails>=5){ s.until=Date.now()+300000; s.fails=0; console.warn(`[CB] ${name} circuit-broken for 5 min`); } }
function srcUp(name){ _src[name]={fails:0,until:0}; }
// 4xx errors mean the symbol doesn't exist on this source — don't penalise the source
class SymbolNotFound extends Error {}
async function trySource(name, fn){
  if (srcSkip(name)) return null;
  try {
    const r = await fn();
    if (r) { srcUp(name); return r; }
    srcDown(name); return null;
  } catch(e) {
    if (e instanceof SymbolNotFound) return null; // symbol absent — don't trip breaker
    srcDown(name); return null;
  }
}

// CoinGecko batch ticker — ONE /coins/markets call covers every pair, cached
// ~12s. Per-symbol calls would instantly hit the free rate limit; one batch
// call per price cycle (~4/min) stays well under it. Throttles retries so a
// failure doesn't hammer the endpoint.
const _cgTick = { data: {}, ts: 0, lastAttempt: 0 };
async function cgTickerBatch() {
  if (Date.now() - _cgTick.ts < 12000 && Object.keys(_cgTick.data).length) return _cgTick.data;
  if (Date.now() - _cgTick.lastAttempt < 12000) return _cgTick.data; // throttle (incl. after failures)
  _cgTick.lastAttempt = Date.now();
  const ids = [...new Set(Object.values(CG_IDS))].join(',');
  const res = await fetch(`${COINGECKO}/coins/markets?vs_currency=usd&ids=${ids}&per_page=250`, { timeout: 12000 });
  if (!res.ok) throw new Error(`CG markets ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error('CG markets bad shape');
  const map = {};
  for (const c of arr) map[c.id] = c;
  _cgTick.data = map; _cgTick.ts = Date.now();
  return map;
}

// One retry on full-chain failure — most timeouts are transient network
// blips; a short pause then a second pass usually succeeds.
async function getBinanceKlines(symbol, interval, limit) {
  try {
    return await fetchKlinesChain(symbol, interval, limit);
  } catch (e) {
    await new Promise(r => setTimeout(r, 1200));
    return await fetchKlinesChain(symbol, interval, limit);
  }
}

async function fetchKlinesChain(symbol, interval, limit) {
  // NG-reachable sources FIRST so we don't time out on geo-blocked exchanges.
  // 1. CryptoCompare — reachable in NG; needs a free API key (401 without one).
  let r = await trySource('cryptocompare', async () => {
    const [ep, agg] = CC_TF[interval] || ['histohour', 1];
    const fsym = ccSym(symbol);
    const url = `${CC_BASE}/${ep}?fsym=${fsym}&tsym=USDT&limit=${limit}&aggregate=${agg}${CC_KEY ? '&api_key=' + CC_KEY : ''}`;
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) throw new Error(`CC ${res.status}`);
    const data = await res.json();
    if (data.Response !== 'Success') {
      if (/not found|no data|invalid/i.test(data.Message || '')) throw new SymbolNotFound(`CC: ${data.Message}`);
      throw new Error(`CC: ${data.Message}`);
    }
    const cc = (data.Data?.Data || []).filter(c => c.close > 0)
      .map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volumefrom }));
    return cc.length ? cc : null;
  });
  if (r) return r;

  // 2. CoinGecko — 4h ONLY (OHLC granularity locked; no per-candle volume). Reliable in NG.
  if (interval === '4h') {
    r = await trySource('coingecko', async () => {
      const id = cgId(symbol);
      if (!id) throw new SymbolNotFound(`no CG id for ${symbol}`);
      const res = await fetch(`${COINGECKO}/coins/${id}/ohlc?vs_currency=usd&days=30`, { timeout: 12000 });
      if (res.status >= 400 && res.status < 500) throw new SymbolNotFound(`CG 4xx ${res.status} for ${symbol}`);
      if (!res.ok) throw new Error(`CG ohlc ${res.status}`);
      const d = await res.json();
      if (!Array.isArray(d) || !d.length) return null;
      return d.map(c => ({ time: Math.floor(c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:0 })).slice(-limit);
    });
    if (r) return r;
  }

  // 3. Yahoo Finance — keyless, works in NG (rate-limit-prone under heavy load)
  r = await trySource('yahoo', async () => {
    const yf = yfSym(symbol);
    const yfRes = await fetch(
      `${YAHOO}/${yf}?interval=${YF_INT[interval]||'1h'}&range=${YF_RANGE[interval]||'30d'}&includePrePost=false`,
      { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!yfRes.ok) throw new Error(`YF ${yfRes.status}`);
    const yfData = await yfRes.json();
    const yfR = yfData.chart?.result?.[0];
    if (!yfR) throw new Error('YF: no data');
    const ts = yfR.timestamp || [], q = yfR.indicators?.quote?.[0] || {};
    const raw = ts.map((t, i) => ({ time: t, open: q.open?.[i]||0, high: q.high?.[i]||0,
      low: q.low?.[i]||0, close: q.close?.[i]||0, volume: q.volume?.[i]||0 })).filter(c => c.close > 0);
    const out = aggregateCandles(raw, YF_AGG[interval] || 1).slice(-limit);
    return out.length ? out : null;
  });
  if (r) return r;

  // 4. Bybit — geo-blocked in NG (circuit-broken after repeated fails); works on cloud
  r = await trySource('bybit', async () => {
    const btf = BYBIT_TF[interval] || '60';
    const url = `${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=${btf}&limit=${limit}`;
    const res = await fetch(url, { timeout: 15000 });
    if (res.status >= 400 && res.status < 500) throw new SymbolNotFound(`Bybit 4xx ${res.status} for ${symbol}`);
    if (!res.ok) throw new Error(`Bybit ${res.status}`);
    const data = await res.json();
    if (data.retCode !== 0) throw new Error(`Bybit: ${data.retMsg}`);
    const candles = [...(data.result?.list || [])].reverse()
      .map(c => ({ time: Math.floor(+c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
    return candles.length ? candles : null;
  });
  if (r) return r;

  // 5. MEXC — geo-blocked in NG; works on cloud (Binance-compatible format)
  r = await trySource('mexc', async () => {
    const url = `${MEXC}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { timeout: 15000 });
    if (res.status >= 400 && res.status < 500) throw new SymbolNotFound(`MEXC 4xx ${res.status} for ${symbol}`);
    if (!res.ok) throw new Error(`MEXC ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    return data.map(c => ({ time: Math.floor(c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
  });
  if (r) return r;

  // 6. OKX — geo-blocked in NG; works on cloud
  r = await trySource('okx', async () => {
    const instId = okxSym(symbol);
    const bar    = OKX_TF[interval] || '1H';
    const url    = `${OKX}/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`;
    const res    = await fetch(url, { timeout: 15000 });
    if (res.status >= 400 && res.status < 500) throw new SymbolNotFound(`OKX 4xx ${res.status} for ${symbol}`);
    if (!res.ok) throw new Error(`OKX ${res.status}`);
    const data = await res.json();
    if (data.code !== '0' || !data.data?.length) return null;
    return [...data.data].reverse().map(c => ({
      time: Math.floor(+c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5],
    }));
  });
  if (r) return r;

  // 7. KuCoin — geo-blocked in NG; works on cloud
  r = await trySource('kucoin', async () => {
    const sym  = kucoinSym(symbol);
    const type = KUCOIN_TF[interval] || '1hour';
    const url  = `${KUCOIN}/api/v1/market/candles?symbol=${sym}&type=${type}`;
    const res  = await fetch(url, { timeout: 15000 });
    if (res.status >= 400 && res.status < 500) throw new SymbolNotFound(`KuCoin 4xx ${res.status} for ${symbol}`);
    if (!res.ok) throw new Error(`KuCoin ${res.status}`);
    const data = await res.json();
    if (data.code !== '200000' || !data.data?.length) return null;
    // KuCoin returns newest-first — reverse, then trim to limit
    return [...data.data].reverse().slice(-limit).map(c => ({
      time: +c[0], open:+c[1], close:+c[2], high:+c[3], low:+c[4], volume:+c[5],
    }));
  });
  if (r) return r;

  // 8. Binance — geo-blocked in NG locally; works when deployed to cloud
  r = await trySource('binance', async () => {
    const url = `${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { timeout: 8000 });
    if (res.status >= 400 && res.status < 500) throw new SymbolNotFound(`Binance 4xx ${res.status} for ${symbol}`);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    return data.map(c => ({ time: Math.floor(c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
  });
  if (r) return r;

  throw new Error(`all sources failed for ${symbol} ${interval}`);
}

async function getBinanceTicker(symbol) {
  // 1. CoinGecko (priority — reliable in Nigeria; full 24h high/low/volume; batched + cached)
  let r = await trySource('coingecko', async () => {
    const id = cgId(symbol);
    if (!id) throw new SymbolNotFound(`no CG id for ${symbol}`);
    const map = await cgTickerBatch();
    const c = map[id];
    if (!c || c.current_price == null) return null;
    return {
      lastPrice: String(c.current_price),
      priceChangePercent: (c.price_change_percentage_24h ?? 0).toFixed(2),
      highPrice: c.high_24h, lowPrice: c.low_24h, quoteVolume: c.total_volume,
    };
  });
  if (r) return r;

  // 2. Bybit ticker
  r = await trySource('bybit', async () => {
    const res = await fetch(`${BYBIT}/v5/market/tickers?category=spot&symbol=${symbol}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`Bybit ticker ${res.status}`);
    const data = await res.json();
    const t = data.result?.list?.[0];
    return t ? { lastPrice: t.lastPrice, priceChangePercent: (+t.price24hPcnt * 100).toFixed(2),
      highPrice: t.highPrice24h, lowPrice: t.lowPrice24h, quoteVolume: t.turnover24h } : null;
  });
  if (r) return r;

  // 2. MEXC ticker
  r = await trySource('mexc', async () => {
    const res = await fetch(`${MEXC}/api/v3/ticker/24hr?symbol=${symbol}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`MEXC ticker ${res.status}`);
    return res.json();
  });
  if (r) return r;

  // 3. OKX ticker
  r = await trySource('okx', async () => {
    const instId = okxSym(symbol);
    const res = await fetch(`${OKX}/api/v5/market/ticker?instId=${instId}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`OKX ticker ${res.status}`);
    const data = await res.json();
    const t = data.data?.[0];
    return t ? { lastPrice: t.last, priceChangePercent: (((+t.last - +t.open24h) / +t.open24h) * 100).toFixed(2),
      highPrice: t.high24h, lowPrice: t.low24h, quoteVolume: t.volCcy24h } : null;
  });
  if (r) return r;

  // 4. KuCoin ticker
  r = await trySource('kucoin', async () => {
    const sym = kucoinSym(symbol);
    const res = await fetch(`${KUCOIN}/api/v1/market/stats?symbol=${sym}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`KuCoin ticker ${res.status}`);
    const data = await res.json();
    const t = data.data;
    return t?.last ? { lastPrice: t.last, priceChangePercent: (+t.changeRate * 100).toFixed(2),
      highPrice: t.high, lowPrice: t.low, quoteVolume: t.volValue } : null;
  });
  if (r) return r;

  // 5. CryptoCompare ticker
  r = await trySource('cryptocompare', async () => {
    const fsym = ccSym(symbol);
    const res = await fetch(`https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${fsym}&tsyms=USDT${CC_KEY ? '&api_key=' + CC_KEY : ''}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`CC ticker ${res.status}`);
    const data = await res.json();
    const info = data.RAW?.[fsym]?.USDT;
    return info ? { lastPrice: info.PRICE.toString(), priceChangePercent: info.CHANGEPCT24HOUR.toFixed(2),
      highPrice: info.HIGH24HOUR, lowPrice: info.LOW24HOUR, quoteVolume: info.VOLUME24HOURTO } : null;
  });
  if (r) return r;

  // 6. Binance ticker — geo-blocked in Nigeria locally; works on cloud
  r = await trySource('binance', async () => {
    const res = await fetch(`${BINANCE}/api/v3/ticker/24hr?symbol=${symbol}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`Ticker ${res.status}`);
    return res.json();
  });
  if (r) return r;

  throw new Error(`all ticker sources failed for ${symbol}`);
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
    ws.send(JSON.stringify({ type: 'summary_init', data: summaryPayload() }));
    // Send current session state immediately on connect
    ws.send(JSON.stringify({
      type: 'sessions', active: engine.getMarketSessions(),
      bonus: engine.getSessionBonus(), utcHour: new Date().getUTCHours(),
    }));
  } catch (e) { console.warn('WS init error:', e.message); }
});

// ═══════════════════════════════════════════════════════════════════
// SIGNAL PROCESSING
// ═══════════════════════════════════════════════════════════════════

// Maximum simultaneous longs or shorts across ALL pairs.
// Prevents correlated crypto-beta wipeout during flash crashes.
const MAX_CORRELATED = 2;

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
        confidence: Math.min(sig.confidence + 4, 96), // +4 pts, hard cap 96
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
      const entryPx  = updates.entry_price ?? sig.entry_price ?? sig.entry;
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
        // FIX 8: risk unit is 1.0R (TP1 = 1.0R in v3)
        const risk = Math.abs(sig.tp1 - sig.entry) / 1.0;
        rMult = risk > 0
          ? (sig.dir === 'long' ? (exitPrice - entryPx) : (entryPx - exitPrice)) / risk
          : 0;
        rMult = Math.max(0, +rMult.toFixed(3));
      } else {
        // Standard entered → SL or direct close (no TP1 hit)
        rMult = updates.status === 'sl_hit' ? -1 : 2.0; // TP2 is 2.0R in v3
      }

      const outcome   = wasTrailing
        ? (updates.status === 'tp2_hit' ? 'tp2' : 'trail')
        : updates.status.replace('_hit', '');
      const pnlPct    = entryPx > 0
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
// FIX 8: STRUCTURE-BASED TRAILING STOP
// After TP1 is hit, trail behind the most recent confirmed swing low
// (long) or swing high (short) using computeStructureTrail from the
// engine — which requires recent candles for swing detection.
// Falls back to 0.5R arithmetic trail when no candle cache is available.
// Stop only moves in favour — never backwards.
// ═══════════════════════════════════════════════════════════════════

function computeTrailStop(sig, price) {
  // Prefer structure-based trail using cached candles for this pair+tf
  const cacheKey = `${sig.pair_id}_${sig.tf}`;
  const cachedCandles = _candleCache[cacheKey];
  if (cachedCandles && cachedCandles.length >= 20) {
    const newSL = engine.computeStructureTrail(sig, cachedCandles);
    if (newSL !== null) return newSL;
  }
  // Arithmetic fallback (0.5R) — matches old behaviour when cache is cold
  const originalRisk = Math.abs(sig.tp1 - sig.entry) / 1.0; // TP1 is now 1.0R
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

const _latestPrices = {}; // pairId → price

async function updateCryptoPrices() {
  for (const pair of CRYPTO_PAIRS) {
    try {
      const ticker = await getBinanceTicker(pair.id);
      const price = +ticker.lastPrice, chg = +ticker.priceChangePercent;
      _latestPrices[pair.id] = price;
      broadcast({ type: 'price', pairId: pair.id, price, change: chg });

      // Update trailing stops first, then check signal statuses
      const active = db.getActiveSignals.all().filter(s => s.pair_id === pair.id);
      for (const sig of active) {
        // Move trail stop for signals that already hit TP1
        if (sig.status === 'tp1_hit') {
          const newTrail = computeTrailStop(sig, price);
          if (newTrail !== null) {
            db.updateSignalSL.run({ id: sig.id, sl: newTrail });
            sig.sl = newTrail; // update in-memory so status check sees it
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
        getBinanceKlines(pair.id, tf, limit),
        getBinanceKlines(pair.id, htfTf, htfLimit),
      ]);
      _candleCache[`${pair.id}_${tf}`] = candles;
      const newSigs = await engine.scanPair(candles, htfCandles, pair, tf, 'crypto');
      for (const sig of newSigs) await processNewSignal(sig);
    } catch (e) {
      const key = `${pair.id}_${tf}`;
      const now = Date.now();
      if (!_failLoggedAt[key] || now - _failLoggedAt[key] > 600000) {
        console.warn(`[Scan] ${pair.id} ${tf}:`, e.message);
        _failLoggedAt[key] = now;
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

// Parallel scanner: splits pairs into batches of 4, runs concurrently.
// Full cycle: ~3 min for 26 pairs (vs 39 min sequential)
// Expire pending signals that are still open when the 18 UTC blackout begins.
// A signal that fired at 17:59 would otherwise get filled during dead-hour fakeouts.
function expireBlackoutSignals() {
  const h = new Date().getUTCHours();
  if (h < 18 || h >= 22) return; // only active during blackout window
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
    await new Promise(r => setTimeout(r, 800)); // slightly longer gap between batches
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

// ── Dedicated 15m fast scanner ────────────────────────────────────
// Runs every 90 s — only the 15m timeframe, all 26 pairs in batches
// of 6. Skips pairs that already have a live 15m signal so the DB
// doesn't fill up with duplicates between full-scan cycles.
async function scan15mFast() {
  const TF       = '15m';
  const HTF      = MTF_MAP[TF];                 // '1h'
  const limit    = CANDLE_LIMIT[TF]  || 200;
  const htfLimit = CANDLE_LIMIT[HTF] || 200;

  // Pairs that already have an active 15m signal — skip them
  const activeTf15 = new Set(
    db.getActiveSignals.all()
      .filter(s => s.tf === TF && ['pending', 'entered', 'tp1_hit'].includes(s.status))
      .map(s => s.pair_id)
  );

  const toScan = CRYPTO_PAIRS.filter(p => !activeTf15.has(p.id));
  if (!toScan.length) return; // nothing to do

  const BATCH = 6;
  let found = 0;
  for (let i = 0; i < toScan.length; i += BATCH) {
    const batch = toScan.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(async pair => {
      const [candles, htfCandles] = await Promise.all([
        getBinanceKlines(pair.id, TF,  limit),
        getBinanceKlines(pair.id, HTF, htfLimit),
      ]);
      // FIX 8: cache candles for structure-based trailing stop
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
  if (!VALID_SYMBOL.test(symbol))   return res.status(400).json({ error: 'Invalid symbol' });
  if (!VALID_INTERVAL.has(interval)) return res.status(400).json({ error: 'Invalid interval' });
  const limit = sanitizeLimit(req.query.limit);
  try {
    const data = await getBinanceKlines(symbol, interval, limit);
    res.json(data);
  } catch {
    res.status(502).json({ error: 'Data fetch failed' });
  }
});

app.get('/api/forex/klines', async (req, res) => {
  const { symbol = '', interval = '' } = req.query;
  if (!VALID_SYMBOL.test(symbol))   return res.status(400).json({ error: 'Invalid symbol' });
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
    const data = await getBinanceTicker(symbol);
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
const BACKTEST_COOLDOWN_MS = 10 * 60 * 1000; // 10 min cooldown between runs
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
  const pairs = req.body.pairs || CRYPTO_PAIRS; // default: all 26 pairs
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
  setInterval(scanCryptoSignals, 4 * 60 * 1000); // full parallel scan every 4 min
  setInterval(scan15mFast,      90 * 1000);       // 15m fast scan every 90 s
  setInterval(scanForexSignals,  5 * 60 * 1000); // scan one forex pair every 5min
  setInterval(updateCryptoPrices, 15 * 1000);    // price refresh every 15s
  setInterval(updateForexPrices,  60 * 1000);    // forex prices every 60s
  setInterval(broadcastSessions,  60 * 1000);    // session update every minute

  // Initial scans on startup — staggered to avoid flooding connections at boot
  setTimeout(updateCryptoPrices,  5000);  // prices first (lightweight)
  setTimeout(scanCryptoSignals,  20000);  // full scan after 20s
  setTimeout(scan15mFast,        35000);  // 15m scan after full scan settles

  server.listen(PORT, HOST, () => {
    console.log(`\n🔺 APEX TERMINAL v2 running on http://${HOST}:${PORT}`);
    console.log(`   Crypto pairs: ${CRYPTO_PAIRS.length}  |  Forex pairs: ${FOREX_PAIRS.length}`);
    console.log(`   Telegram: ${process.env.TELEGRAM_TOKEN ? '✓ configured' : '✗ not set (add to .env)'}`);
    console.log(`   Twelve Data: ${TWELVE_KEY && TWELVE_KEY !== 'your_twelve_data_key_here' ? '✓ configured' : '✗ not set (forex disabled)'}\n`);
  });
}

// ═══════════════════════════════════════════════════════════════════
// CRASH GUARDS — a long-running market server must survive transient
// network failures. A timed-out fetch or stray rejection is logged and
// swallowed so the process keeps running and auto-recovers when the
// connection returns, instead of exiting back to the shell.
// ═══════════════════════════════════════════════════════════════════
process.on('unhandledRejection', (reason) => {
  console.warn('[unhandledRejection]', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.warn('[uncaughtException]', err && err.message ? err.message : err);
});

start().catch(console.error);
