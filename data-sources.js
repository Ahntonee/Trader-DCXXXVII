'use strict';
const fetch = require('node-fetch');
const { TWELVE_KEY } = require('./config');

// ─────────────────────────────────────────────────────────────────────
// DATA-SOURCES — 3-source data layer: CoinGecko (ticker) → KuCoin → Binance
// ─────────────────────────────────────────────────────────────────────

const BINANCE   = 'https://api.binance.com';
const KUCOIN    = 'https://api.kucoin.com';
const COINGECKO = 'https://api.coingecko.com/api/v3';
const TWELVE    = 'https://api.twelvedata.com';

const KUCOIN_TF = { '15m':'15min', '1h':'1hour', '4h':'4hour', '1d':'1day' };

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

function ccSym(s)     { return s.endsWith('USDT') ? s.slice(0, -4) : s; }
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════
// LIVE CIRCUIT BREAKER
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
// LIVE KLINES — KuCoin → Binance
// ═══════════════════════════════════════════════════════════════════

async function fetchKlinesChain(symbol, interval, limit) {
  let r;

  // 1. KuCoin
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

  // 2. Binance
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

async function getLiveKlines(symbol, interval, limit) {
  try {
    return await fetchKlinesChain(symbol, interval, limit);
  } catch (e) {
    await sleep(1200);
    return fetchKlinesChain(symbol, interval, limit);
  }
}

// ═══════════════════════════════════════════════════════════════════
// LIVE TICKER — CoinGecko → KuCoin → Binance
// ═══════════════════════════════════════════════════════════════════

async function getLiveTicker(symbol) {
  let r;

  // 1. CoinGecko — batched + cached, free, full 24h stats
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

  // 2. KuCoin
  r = await trySource('kucoin', async () => {
    const res  = await fetch(`${KUCOIN}/api/v1/market/stats?symbol=${kucoinSym(symbol)}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`KuCoin ticker ${res.status}`);
    const data = await res.json();
    const t    = data.data;
    return t?.last ? { lastPrice: t.last, priceChangePercent: (+t.changeRate * 100).toFixed(2),
      highPrice: t.high, lowPrice: t.low, quoteVolume: t.volValue } : null;
  });
  if (r) return r;

  // 3. Binance
  r = await trySource('binance', async () => {
    const res = await fetch(`${BINANCE}/api/v3/ticker/24hr?symbol=${symbol}`, { timeout: 5000 });
    if (!res.ok) throw new Error(`Ticker ${res.status}`);
    return res.json();
  });
  if (r) return r;

  throw new Error(`all ticker sources failed for ${symbol}`);
}

// ═══════════════════════════════════════════════════════════════════
// FOREX KLINES / PRICE (TwelveData)
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
// HISTORICAL KLINES — KuCoin → Binance (for backtesting)
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
  c = await tryHistSource('KuCoin',  () => _kucoinHistKlines(symbol, interval, startTime, msPerBar));   if (c) return c;
  c = await tryHistSource('Binance', () => _binanceHistKlines(symbol, interval, startTime, msPerBar));  if (c) return c;
  console.warn(`[Backtest] All sources failed for ${symbol} ${interval}`);
  return [];
}

module.exports = {
  getLiveKlines,
  getLiveTicker,
  getForexKlines, getForexPrice,
  fetchHistoricalKlines, clearHistDeadSet,
  aggregateCandles, cgTickerBatch, cgId, ccSym,
  getSrcStatus: () => ({ ..._src }),
};
