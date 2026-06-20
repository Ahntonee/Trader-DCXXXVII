'use strict';
const fetch = require('node-fetch');
// config.js calls require('dotenv').config() — importing it first ensures
// env vars are loaded before we read CC_KEY / TWELVE_KEY below.
const { CC_KEY, TWELVE_KEY } = require('./config');

// ─────────────────────────────────────────────────────────────────────
// DATA-SOURCES — unified 8-source data layer shared by server.js and
// backtester.js.  Previously each module had its own private copy of
// all exchange fetch functions; any bug fix had to be applied twice,
// and the backtester had no circuit breaker (causing Nigeria timeout
// storms on every run).  This module is the single source of truth.
// ─────────────────────────────────────────────────────────────────────

// ── Exchange base URLs ─────────────────────────────────────────────
const BINANCE   = 'https://api.binance.com';
const BYBIT     = 'https://api.bybit.com';
const MEXC      = 'https://api.mexc.com';
const OKX       = 'https://www.okx.com';
const KUCOIN    = 'https://api.kucoin.com';
const COINGECKO = 'https://api.coingecko.com/api/v3';
const CC_BASE   = 'https://min-api.cryptocompare.com/data/v2';
const YAHOO     = 'https://query1.finance.yahoo.com/v8/finance/chart';
const TWELVE    = 'https://api.twelvedata.com';

// ── Exchange timeframe maps ────────────────────────────────────────
const BYBIT_TF  = { '15m':'15',    '1h':'60',    '4h':'240',   '1d':'D' };
const OKX_TF    = { '15m':'15m',   '1h':'1H',    '4h':'4H',    '1d':'1D' };
const KUCOIN_TF = { '15m':'15min', '1h':'1hour', '4h':'4hour', '1d':'1day' };
const CC_TF     = { '15m':['histominute',15],'1h':['histohour',1],'4h':['histohour',4],'1d':['histoday',1] };
const YF_INT    = { '15m':'15m', '1h':'1h', '4h':'1h', '1d':'1d' };
// Live fetch ranges (recent bars only):
const YF_RANGE      = { '15m':'5d',  '1h':'30d',  '4h':'120d', '1d':'200d' };
// Historical fetch ranges (months of data):
const YF_HIST_RANGE = { '15m':'60d', '1h':'2y',   '4h':'2y',   '1d':'5y'   };
const YF_AGG        = { '4h': 4 };

// ── CoinGecko coin-ID map ─────────────────────────────────────────
const CG_IDS = {
  BTC:'bitcoin',  ETH:'ethereum',    SOL:'solana',               BNB:'binancecoin',
  XRP:'ripple',   ADA:'cardano',     DOGE:'dogecoin',            AVAX:'avalanche-2',
  TRX:'tron',     TON:'the-open-network', HYPE:'hyperliquid',   SUI:'sui',
  LINK:'chainlink', DOT:'polkadot',  LTC:'litecoin',             ONDO:'ondo-finance',
  PEPE:'pepe',    WIF:'dogwifcoin',  SHIB:'shiba-inu',           NEAR:'near',
  INJ:'injective-protocol', OP:'optimism', ARB:'arbitrum',       JUP:'jupiter-exchange-solana',
  APT:'aptos',    ATOM:'cosmos',     TIA:'celestia',
};

// ── Symbol converters ──────────────────────────────────────────────
function ccSym(s)     { return s.endsWith('USDT') ? s.slice(0, -4) : s; }
function yfSym(s)     { return s.endsWith('USDT') ? `${s.slice(0,-4)}-USD` : s; }
function okxSym(s)    { return s.endsWith('USDT') ? `${s.slice(0,-4)}-USDT` : s; }
function kucoinSym(s) { return s.endsWith('USDT') ? `${s.slice(0,-4)}-USDT` : s; }
function cgId(s)      { return CG_IDS[ccSym(s)] || null; }

// ── Candle utilities ───────────────────────────────────────────────
function aggregateCandles(candles, factor) {
  if (!factor || factor <= 1) return candles;
  const out = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    out.push({
      time:   chunk[0].time,
      open:   chunk[0].open,
      high:   Math.max(...chunk.map(c => c.high)),
      low:    Math.min(...chunk.map(c => c.low)),
      close:  chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

function parseBybitCandles(list) {
  return [...list].reverse().map(c => ({
    time: Math.floor(+c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5],
  }));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════
// LIVE CIRCUIT BREAKER
//
// A geo-blocked source (Binance/Bybit/MEXC/OKX/KuCoin in Nigeria)
// wastes several seconds timing out on every call.  After 5 consecutive
// failures we skip it for a 5-min cooldown, then probe once more.
// Auto-recovers when the source becomes reachable (e.g. on a cloud host).
// ═══════════════════════════════════════════════════════════════════

const _src = {};
function srcSkip(name) { const s = _src[name]; return !!(s && s.until > Date.now()); }
function srcDown(name) {
  const s = _src[name] || (_src[name] = { fails: 0, until: 0 });
  if (++s.fails >= 5) {
    s.until = Date.now() + 300_000;
    s.fails = 0;
    console.warn(`[CB] ${name} circuit-broken for 5 min`);
  }
}
function srcUp(name) { _src[name] = { fails: 0, until: 0 }; }

class SymbolNotFound extends Error {}

async function trySource(name, fn) {
  if (srcSkip(name)) return null;
  try {
    const r = await fn();
    if (r) { srcUp(name); return r; }
    srcDown(name); return null;
  } catch (e) {
    if (e instanceof SymbolNotFound) return null;
    srcDown(name); return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// COINGECKO BATCH TICKER CACHE
//
// One /coins/markets call covers all 26+ pairs, cached 12 s.
// Per-symbol calls would immediately hit the free-tier rate limit.
// The dual lastAttempt guard prevents two concurrent stale callers
// from both firing a fetch simultaneously.
// ═══════════════════════════════════════════════════════════════════

const _cgTick = { data: {}, ts: 0, lastAttempt: 0 };
async function cgTickerBatch() {
  const now = Date.now();
  if (now - _cgTick.ts < 12_000 && Object.keys(_cgTick.data).length) return _cgTick.data;
  if (now - _cgTick.lastAttempt < 12_000) return _cgTick.data;
  _cgTick.lastAttempt = now;
  const ids = [...new Set(Object.values(CG_IDS))].join(',');
  const res = await fetch(`${COINGECKO}/coins/markets?vs_currency=usd&ids=${ids}&per_page=250`, { timeout: 12_000 });
  if (!res.ok) throw new Error(`CG markets ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error('CG markets bad shape');
  const map = {};
  for (const c of arr) map[c.id] = c;
  _cgTick.data = map;
  _cgTick.ts   = Date.now();
  return map;
}

// ═══════════════════════════════════════════════════════════════════
// LIVE KLINES — recent N bars with circuit-breaker fallback chain.
//
// Source order: NG-reachable first so geo-blocked exchanges don't
// drain timeout budget on every call when running locally in Nigeria.
// ═══════════════════════════════════════════════════════════════════

async function fetchKlinesChain(symbol, interval, limit) {
  let r;

  // 1. CryptoCompare — NG-reachable; needs free API key (401 without one)
  r = await trySource('cryptocompare', async () => {
    const [ep, agg] = CC_TF[interval] || ['histohour', 1];
    const url = `${CC_BASE}/${ep}?fsym=${ccSym(symbol)}&tsym=USDT&limit=${limit}&aggregate=${agg}${CC_KEY ? '&api_key=' + CC_KEY : ''}`;
    const res = await fetch(url, { timeout: 10_000 });
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

  // 2. CoinGecko 4h OHLC — NG-reliable; granularity locked; no per-candle volume
  if (interval === '4h') {
    r = await trySource('coingecko', async () => {
      const id = cgId(symbol);
      if (!id) throw new SymbolNotFound(`no CG id for ${symbol}`);
      const res = await fetch(`${COINGECKO}/coins/${id}/ohlc?vs_currency=usd&days=30`, { timeout: 12_000 });
      if (res.status >= 400 && res.status < 500) throw new SymbolNotFound(`CG 4xx ${res.status} for ${symbol}`);
      if (!res.ok) throw new Error(`CG ohlc ${res.status}`);
      const d = await res.json();
      if (!Array.isArray(d) || !d.length) return null;
      return d.map(c => ({ time: Math.floor(c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume: 0 })).slice(-limit);
    });
    if (r) return r;
  }

  // 3. Yahoo Finance — keyless, NG-friendly (rate-limit-prone under heavy load)
  r = await trySource('yahoo', async () => {
    const res = await fetch(
      `${YAHOO}/${yfSym(symbol)}?interval=${YF_INT[interval]||'1h'}&range=${YF_RANGE[interval]||'30d'}&includePrePost=false`,
      { timeout: 15_000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!res.ok) throw new Error(`YF ${res.status}`);
    const yfData = await res.json();
    const yfR = yfData.chart?.result?.[0];
    if (!yfR) throw new Error('YF: no data');
    const ts = yfR.timestamp || [], q = yfR.indicators?.quote?.[0] || {};
    const raw = ts.map((t, i) => ({ time: t, open: q.open?.[i]||0, high: q.high?.[i]||0,
      low: q.low?.[i]||0, close: q.close?.[i]||0, volume: q.volume?.[i]||0 })).filter(c => c.close > 0);
    const out = aggregateCandles(raw, YF_AGG[interval] || 1).slice(-limit);
    return out.length ? out : null;
  });
  if (r) return r;

  // 4–8. Geo-blocked in Nigeria locally; work on cloud hosts
  r = await trySource('bybit', async () => {
    const url = `${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=${BYBIT_TF[interval]||'60'}&limit=${limit}`;
    const res = await fetch(url, { timeout: 15_000 });
    if (res.status >= 400 && res.status < 500) throw new SymbolNotFound(`Bybit 4xx ${res.status}`);
    if (!res.ok) throw new Error(`Bybit ${res.status}`);
    const data = await res.json();
    if (data.retCode !== 0) throw new Error(`Bybit: ${data.retMsg}`);
    const candles = parseBybitCandles(data.result?.list || []);
    return candles.length ? candles : null;
  });
  if (r) return r;

  r = await trySource('mexc', async () => {
    const url = `${MEXC}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { timeout: 15_000 });
    if (res.status >= 400 && res.status < 500) throw new SymbolNotFound(`MEXC 4xx ${res.status}`);
    if (!res.ok) throw new Error(`MEXC ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    return data.map(c => ({ time: Math.floor(c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
  });
  if (r) return r;

  r = await trySource('okx', async () => {
    const url = `${OKX}/api/v5/market/candles?instId=${okxSym(symbol)}&bar=${OKX_TF[interval]||'1H'}&limit=${limit}`;
    const res = await fetch(url, { timeout: 15_000 });
    if (res.status >= 400 && res.status < 500) throw new SymbolNotFound(`OKX 4xx ${res.status}`);
    if (!res.ok) throw new Error(`OKX ${res.status}`);
    const data = await res.json();
    if (data.code !== '0' || !data.data?.length) return null;
    return [...data.data].reverse().map(c => ({
      time: Math.floor(+c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5],
    }));
  });
  if (r) return r;

  r = await trySource('kucoin', async () => {
    const url = `${KUCOIN}/api/v1/market/candles?symbol=${kucoinSym(symbol)}&type=${KUCOIN_TF[interval]||'1hour'}`;
    const res = await fetch(url, { timeout: 15_000 });
    if (res.status >= 400 && res.status < 500) throw new SymbolNotFound(`KuCoin 4xx ${res.status}`);
    if (!res.ok) throw new Error(`KuCoin ${res.status}`);
    const data = await res.json();
    if (data.code !== '200000' || !data.data?.length) return null;
    return [...data.data].reverse().slice(-limit).map(c => ({
      time: +c[0], open:+c[1], close:+c[2], high:+c[3], low:+c[4], volume:+c[5],
    }));
  });
  if (r) return r;

  r = await trySource('binance', async () => {
    const url = `${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { timeout: 8_000 });
    if (res.status >= 400 && res.status < 500) throw new SymbolNotFound(`Binance 4xx ${res.status}`);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    return data.map(c => ({ time: Math.floor(c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
  });
  if (r) return r;

  throw new Error(`all sources failed for ${symbol} ${interval}`);
}

// One retry on full-chain failure — most timeouts are transient blips
async function getLiveKlines(symbol, interval, limit) {
  try {
    return await fetchKlinesChain(symbol, interval, limit);
  } catch (e) {
    await sleep(1200);
    return fetchKlinesChain(symbol, interval, limit);
  }
}

// ═══════════════════════════════════════════════════════════════════
// LIVE TICKER — 24h price / change / high / low / volume
// ═══════════════════════════════════════════════════════════════════

async function getLiveTicker(symbol) {
  let r;

  // 1. CoinGecko — batched + cached, NG-friendly, full 24h stats
  r = await trySource('coingecko', async () => {
    const id = cgId(symbol);
    if (!id) throw new SymbolNotFound(`no CG id for ${symbol}`);
    const map = await cgTickerBatch();
    const c   = map[id];
    if (!c || c.current_price == null) return null;
    return {
      lastPrice:          String(c.current_price),
      priceChangePercent: (c.price_change_percentage_24h ?? 0).toFixed(2),
      highPrice:   c.high_24h,
      lowPrice:    c.low_24h,
      quoteVolume: c.total_volume,
    };
  });
  if (r) return r;

  // 2. Bybit
  r = await trySource('bybit', async () => {
    const res  = await fetch(`${BYBIT}/v5/market/tickers?category=spot&symbol=${symbol}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`Bybit ticker ${res.status}`);
    const data = await res.json();
    const t    = data.result?.list?.[0];
    return t ? { lastPrice: t.lastPrice, priceChangePercent: (+t.price24hPcnt * 100).toFixed(2),
      highPrice: t.highPrice24h, lowPrice: t.lowPrice24h, quoteVolume: t.turnover24h } : null;
  });
  if (r) return r;

  // 3. MEXC
  r = await trySource('mexc', async () => {
    const res = await fetch(`${MEXC}/api/v3/ticker/24hr?symbol=${symbol}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`MEXC ticker ${res.status}`);
    return res.json();
  });
  if (r) return r;

  // 4. OKX
  r = await trySource('okx', async () => {
    const res  = await fetch(`${OKX}/api/v5/market/ticker?instId=${okxSym(symbol)}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`OKX ticker ${res.status}`);
    const data = await res.json();
    const t    = data.data?.[0];
    return t ? { lastPrice: t.last, priceChangePercent: (((+t.last - +t.open24h) / +t.open24h) * 100).toFixed(2),
      highPrice: t.high24h, lowPrice: t.low24h, quoteVolume: t.volCcy24h } : null;
  });
  if (r) return r;

  // 5. KuCoin
  r = await trySource('kucoin', async () => {
    const res  = await fetch(`${KUCOIN}/api/v1/market/stats?symbol=${kucoinSym(symbol)}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`KuCoin ticker ${res.status}`);
    const data = await res.json();
    const t    = data.data;
    return t?.last ? { lastPrice: t.last, priceChangePercent: (+t.changeRate * 100).toFixed(2),
      highPrice: t.high, lowPrice: t.low, quoteVolume: t.volValue } : null;
  });
  if (r) return r;

  // 6. CryptoCompare
  r = await trySource('cryptocompare', async () => {
    const fsym = ccSym(symbol);
    const url  = `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${fsym}&tsyms=USDT${CC_KEY ? '&api_key=' + CC_KEY : ''}`;
    const res  = await fetch(url, { timeout: 5000 });
    if (!res.ok) throw new Error(`CC ticker ${res.status}`);
    const data = await res.json();
    const info = data.RAW?.[fsym]?.USDT;
    return info ? { lastPrice: info.PRICE.toString(), priceChangePercent: info.CHANGEPCT24HOUR.toFixed(2),
      highPrice: info.HIGH24HOUR, lowPrice: info.LOW24HOUR, quoteVolume: info.VOLUME24HOURTO } : null;
  });
  if (r) return r;

  // 7. Binance — geo-blocked in Nigeria locally; works on cloud
  r = await trySource('binance', async () => {
    const res = await fetch(`${BINANCE}/api/v3/ticker/24hr?symbol=${symbol}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`Ticker ${res.status}`);
    return res.json();
  });
  if (r) return r;

  throw new Error(`all ticker sources failed for ${symbol}`);
}

// ═══════════════════════════════════════════════════════════════════
// FOREX KLINES / PRICE (TwelveData — returns empty when key not set)
// ═══════════════════════════════════════════════════════════════════

async function getForexKlines(symbol, interval, limit = 200) {
  if (!TWELVE_KEY || TWELVE_KEY === 'your_twelve_data_key_here') return [];
  const tfMap = { '15m':'15min', '1h':'1h', '4h':'4h', '1d':'1day' };
  const url   = `${TWELVE}/time_series?symbol=${symbol}&interval=${tfMap[interval]||'1h'}&outputsize=${limit}&apikey=${TWELVE_KEY}`;
  try {
    const res  = await fetch(url, { timeout: 10_000 });
    const data = await res.json();
    if (!data.values) return [];
    return data.values.reverse().map(c => ({
      time:   Math.floor(new Date(c.datetime).getTime() / 1000),
      open:   +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +(c.volume || 0),
    }));
  } catch { return []; }
}

async function getForexPrice(symbol) {
  if (!TWELVE_KEY || TWELVE_KEY === 'your_twelve_data_key_here') return null;
  try {
    const res  = await fetch(`${TWELVE}/price?symbol=${symbol}&apikey=${TWELVE_KEY}`, { timeout: 5000 });
    const data = await res.json();
    return data.price ? +data.price : null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// HISTORICAL KLINES — months of paginated data for backtesting.
//
// Uses a per-run dead-set (_histDead) so a geo-blocked source that
// times out on the first pair is skipped for every remaining pair in
// the same run, instead of re-timing-out 26× per source.
// Call clearHistDeadSet() at the start of each runBacktest().
// ═══════════════════════════════════════════════════════════════════

const _histDead = new Set();
function clearHistDeadSet() { _histDead.clear(); }

async function tryHistSource(name, fn) {
  if (_histDead.has(name)) return null;
  try {
    const candles = await fn();
    if (candles && candles.length >= 100) {
      console.log(`[Backtest] ${name}: ${candles.length} bars`);
      return candles;
    }
    return null;
  } catch (e) {
    console.warn(`[Backtest] ${name} failed: ${e.message}`);
    if (/timeout|ENOTFOUND|ECONNRESET|ECONNREFUSED|getaddrinfo|network|socket/i.test(e.message)) {
      _histDead.add(name);
    }
    return null;
  }
}

// CryptoCompare — limit=2000 gives ~2 years of hourly data in one call
async function _ccHistKlines(symbol, interval) {
  const [ep, agg] = CC_TF[interval] || ['histohour', 1];
  const url = `${CC_BASE}/${ep}?fsym=${ccSym(symbol)}&tsym=USDT&limit=2000&aggregate=${agg}${CC_KEY ? '&api_key=' + CC_KEY : ''}`;
  const res = await fetch(url, { timeout: 15_000 });
  if (!res.ok) throw new Error(`CC ${res.status}`);
  const data = await res.json();
  if (data.Response !== 'Success') throw new Error(`CC: ${data.Message}`);
  return (data.Data?.Data || []).filter(c => c.close > 0)
    .map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volumefrom }));
}

// Yahoo — uses extended historical ranges (up to 5y for daily)
async function _yfHistKlines(symbol, interval) {
  const res = await fetch(
    `${YAHOO}/${yfSym(symbol)}?interval=${YF_INT[interval]||'1h'}&range=${YF_HIST_RANGE[interval]||'2y'}&includePrePost=false`,
    { timeout: 15_000, headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!res.ok) throw new Error(`YF ${res.status}`);
  const data = await res.json();
  const result = data.chart?.result?.[0];
  if (!result) throw new Error('YF: no data');
  const ts = result.timestamp || [], q = result.indicators?.quote?.[0] || {};
  const candles = ts.map((t, i) => ({ time: t, open: q.open?.[i]||0, high: q.high?.[i]||0,
    low: q.low?.[i]||0, close: q.close?.[i]||0, volume: q.volume?.[i]||0 })).filter(c => c.close > 0);
  return aggregateCandles(candles, YF_AGG[interval] || 1);
}

// Paginated exchange fetchers (used when CC/Yahoo lack the depth)
async function _bybitHistKlines(symbol, interval, startTime, msPerBar) {
  const allCandles = [];
  let start = startTime;
  while (start < Date.now() - msPerBar * 2) {
    const end = start + 1000 * msPerBar;
    const url = `${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=${BYBIT_TF[interval]||'60'}&start=${start}&end=${end}&limit=1000`;
    const res = await fetch(url, { timeout: 15_000 });
    if (!res.ok) throw new Error(`Bybit ${res.status}`);
    const data = await res.json();
    if (data.retCode !== 0 || !data.result?.list?.length) break;
    parseBybitCandles(data.result.list).forEach(c => allCandles.push(c));
    start = +data.result.list[0][0] + msPerBar;
    await sleep(150);
  }
  return allCandles;
}

async function _mexcHistKlines(symbol, interval, startTime, msPerBar) {
  const allCandles = [];
  let start = startTime;
  while (start < Date.now() - msPerBar * 2) {
    const url = `${MEXC}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&limit=1000`;
    const res = await fetch(url, { timeout: 15_000 });
    if (!res.ok) throw new Error(`MEXC ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    const batch = data.map(c => ({ time: Math.floor(c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
    batch.forEach(c => allCandles.push(c));
    start = data[data.length - 1][0] + msPerBar;
    await sleep(150);
  }
  return allCandles;
}

async function _okxHistKlines(symbol, interval, startTime) {
  const allCandles = [];
  let after  = '';
  const instId = okxSym(symbol);
  const bar    = OKX_TF[interval] || '1H';
  while (true) {
    const url  = `${OKX}/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=300${after ? '&after=' + after : ''}`;
    const res  = await fetch(url, { timeout: 15_000 });
    if (!res.ok) throw new Error(`OKX ${res.status}`);
    const data = await res.json();
    if (data.code !== '0' || !data.data?.length) break;
    const batch = [...data.data].reverse().map(c => ({
      time: Math.floor(+c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5],
    }));
    batch.forEach(c => allCandles.push(c));
    const oldest = +data.data[data.data.length - 1][0];
    if (oldest <= startTime) break;
    after = oldest.toString();
    await sleep(150);
  }
  return allCandles.filter(c => c.time * 1000 >= startTime).sort((a, b) => a.time - b.time);
}

async function _kucoinHistKlines(symbol, interval, startTime, msPerBar) {
  const allCandles = [];
  const type  = KUCOIN_TF[interval] || '1hour';
  const sym   = kucoinSym(symbol);
  let start   = Math.floor(startTime / 1000);
  while (start < Math.floor(Date.now() / 1000) - msPerBar / 1000 * 2) {
    const end = start + Math.floor(msPerBar / 1000) * 1500;
    const url = `${KUCOIN}/api/v1/market/candles?symbol=${sym}&type=${type}&startAt=${start}&endAt=${end}`;
    const res = await fetch(url, { timeout: 15_000 });
    if (!res.ok) throw new Error(`KuCoin ${res.status}`);
    const data = await res.json();
    if (data.code !== '200000' || !data.data?.length) break;
    const batch = [...data.data].reverse().map(c => ({
      time: +c[0], open:+c[1], close:+c[2], high:+c[3], low:+c[4], volume:+c[5],
    }));
    batch.forEach(c => allCandles.push(c));
    start = batch[batch.length - 1].time + Math.floor(msPerBar / 1000);
    await sleep(150);
  }
  return allCandles;
}

async function _binanceHistKlines(symbol, interval, startTime, msPerBar) {
  const allCandles = [];
  let start = startTime;
  while (start < Date.now() - msPerBar * 2) {
    const url = `${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&limit=1000`;
    const res = await fetch(url, { timeout: 15_000 });
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    const batch = data.map(c => ({ time: Math.floor(c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
    batch.forEach(c => allCandles.push(c));
    start = data[data.length - 1][0] + msPerBar;
    await sleep(150);
  }
  return allCandles;
}

async function fetchHistoricalKlines(symbol, interval, months = 18) {
  const msPerBar  = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }[interval] || 3_600_000;
  const startTime = Date.now() - months * 30 * 24 * 3_600_000;
  let c;
  c = await tryHistSource('CryptoCompare', () => _ccHistKlines(symbol, interval));                            if (c) return c;
  c = await tryHistSource('Yahoo',         () => _yfHistKlines(symbol, interval));                             if (c) return c;
  c = await tryHistSource('Bybit',         () => _bybitHistKlines(symbol, interval, startTime, msPerBar));     if (c) return c;
  c = await tryHistSource('MEXC',          () => _mexcHistKlines(symbol, interval, startTime, msPerBar));      if (c) return c;
  c = await tryHistSource('OKX',           () => _okxHistKlines(symbol, interval, startTime));                 if (c) return c;
  c = await tryHistSource('KuCoin',        () => _kucoinHistKlines(symbol, interval, startTime, msPerBar));    if (c) return c;
  c = await tryHistSource('Binance',       () => _binanceHistKlines(symbol, interval, startTime, msPerBar));   if (c) return c;
  console.warn(`[Backtest] All sources failed for ${symbol} ${interval}`);
  return [];
}

module.exports = {
  // Live klines
  getLiveKlines,
  // Live ticker
  getLiveTicker,
  // Forex
  getForexKlines, getForexPrice,
  // Historical (backtester)
  fetchHistoricalKlines, clearHistDeadSet,
  // Shared utilities
  aggregateCandles, cgTickerBatch, cgId, ccSym,
  // Circuit breaker status (exposed for /health endpoint)
  getSrcStatus: () => ({ ..._src }),
};
