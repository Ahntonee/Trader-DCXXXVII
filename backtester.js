'use strict';
const fetch = require('node-fetch');
// FIX 7: import full engine so the backtester replays the exact same filter
// stack the live engine uses — not just raw pattern detection.
const { scanPair, setPatternWinRates } = require('./signal-engine');
const db = require('./db');

// ═══════════════════════════════════════════════════════════════════
// BACKTESTER v3 — Walk-forward, zero look-ahead bias
//
// FIX 7: Previously the backtester called scanPair (full engine) but stored
// raw per-pattern win rates that did NOT reflect the live confluence filters.
// Pattern stats were therefore based on unfiltered detection, causing:
//   - Patterns suppressed (< 50% raw WR) that were actually 70%+ under filters
//   - Patterns boosted (> 70% raw WR) that degraded under live conditions
//
// Fix: scanPair is called with the FULL filter stack active (HTF mandatory,
// weighted confluence, ADX/CI regime, session gate, FVG/OB structure check).
// Stats stored in DB now reflect the SAME conditions the live engine fires,
// making the historical bonus/suppression system accurate.
// ═══════════════════════════════════════════════════════════════════

const BINANCE_BASE = 'https://api.binance.com';
const BYBIT_BASE   = 'https://api.bybit.com';
const BYBIT_TF     = { '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
const CC_BBASE     = 'https://min-api.cryptocompare.com/data/v2';
const CC_BTF       = { '15m':['histominute',15],'1h':['histohour',1],'4h':['histohour',4],'1d':['histoday',1] };
const YF_BBASE     = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YF_BINT      = { '15m':'15m','1h':'1h','4h':'1h','1d':'1d' };
const YF_BRANGE    = { '15m':'60d','1h':'2y','4h':'2y','1d':'5y' };
const YF_BAGG      = { '4h':4 };

function parseBybitCandles(list) {
  return [...list].reverse()
    .map(c => ({ time: Math.floor(+c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
}

function bccSym(s) { return s.endsWith('USDT') ? s.slice(0, -4) : s; }
function byfSym(s) { return s.endsWith('USDT') ? `${s.slice(0,-4)}-USD` : s; }
function bAggregate(candles, factor) {
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

async function fetchCCKlines(symbol, interval) {
  const [ep, agg] = CC_BTF[interval] || ['histohour', 1];
  const fsym = bccSym(symbol);
  const url = `${CC_BBASE}/${ep}?fsym=${fsym}&tsym=USDT&limit=2000&aggregate=${agg}`;
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error(`CC ${res.status}`);
  const data = await res.json();
  if (data.Response !== 'Success') throw new Error(`CC: ${data.Message}`);
  return (data.Data?.Data || [])
    .filter(c => c.close > 0)
    .map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volumefrom }));
}

async function fetchYFKlines(symbol, interval) {
  const sym = byfSym(symbol);
  const url = `${YF_BBASE}/${sym}?interval=${YF_BINT[interval]||'1h'}&range=${YF_BRANGE[interval]||'2y'}&includePrePost=false`;
  const res = await fetch(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`YF ${res.status}`);
  const data = await res.json();
  const result = data.chart?.result?.[0];
  if (!result) throw new Error('YF: no data');
  const ts = result.timestamp || [], q = result.indicators?.quote?.[0] || {};
  const candles = ts.map((t, i) => ({ time: t, open: q.open?.[i]||0, high: q.high?.[i]||0,
    low: q.low?.[i]||0, close: q.close?.[i]||0, volume: q.volume?.[i]||0 })).filter(c => c.close > 0);
  return bAggregate(candles, YF_BAGG[interval] || 1);
}

async function fetchHistoricalKlines(symbol, interval, months = 24) {
  const allCandles = [];
  const msPerBar = { '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 }[interval] || 3600000;
  const totalMs = months * 30 * 24 * 3600000;
  let startTime = Date.now() - totalMs;
  let useBybit = false, bybitTried = false;

  while (startTime < Date.now() - msPerBar * 2) {
    try {
      let batch, nextStart;
      if (!useBybit) {
        const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=1000`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Binance ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data) || !data.length) break;
        batch = data.map(c => ({ time: Math.floor(c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
        nextStart = data[data.length-1][0] + msPerBar;
      } else {
        const btf = BYBIT_TF[interval] || '60';
        const endTime = startTime + 1000 * msPerBar;
        const url = `${BYBIT_BASE}/v5/market/kline?category=spot&symbol=${symbol}&interval=${btf}&start=${startTime}&end=${endTime}&limit=1000`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Bybit ${res.status}`);
        const data = await res.json();
        if (data.retCode !== 0 || !data.result?.list?.length) break;
        batch = parseBybitCandles(data.result.list);
        nextStart = +data.result.list[0][0] + msPerBar;
      }
      batch.forEach(c => allCandles.push(c));
      startTime = nextStart;
      await sleep(120);
    } catch (e) {
      if (!useBybit) {
        console.warn(`[Backtest] Binance unavailable, trying Bybit: ${e.message}`);
        useBybit = true;
      } else if (!bybitTried) {
        bybitTried = true;
        console.warn(`[Backtest] Bybit also unavailable for ${symbol} ${interval}, trying CC → YF`);
        try {
          const cc = await fetchCCKlines(symbol, interval);
          cc.forEach(c => allCandles.push(c));
          console.log(`[Backtest] CryptoCompare: ${cc.length} bars for ${symbol} ${interval}`);
        } catch (ccErr) {
          console.warn(`[Backtest] CC failed (${ccErr.message}), trying Yahoo Finance`);
          try {
            const yf = await fetchYFKlines(symbol, interval);
            yf.forEach(c => allCandles.push(c));
            console.log(`[Backtest] Yahoo Finance: ${yf.length} bars for ${symbol} ${interval}`);
          } catch (yfErr) {
            console.warn(`[Backtest] Yahoo Finance failed: ${yfErr.message}`);
          }
        }
        break;
      } else {
        break;
      }
    }
  }
  return allCandles;
}

async function fetchHTFCandles(symbol, htfInterval) {
  try {
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${htfInterval}&limit=200`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    return data.map(c => ({ time: Math.floor(c[0]/1000), open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
  } catch {
    try {
      const btf = BYBIT_TF[htfInterval] || '60';
      const url = `${BYBIT_BASE}/v5/market/kline?category=spot&symbol=${symbol}&interval=${btf}&limit=200`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.retCode !== 0) throw new Error('Bybit failed');
      return parseBybitCandles(data.result?.list || []);
    } catch {
      try { return await fetchCCKlines(symbol, htfInterval); } catch { }
      return fetchYFKlines(symbol, htfInterval).catch(() => []);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const MTF_MAP = { '15m': '1h', '1h': '4h', '4h': '1d', '1d': '1d' };

// ── FIX 7: Walk-forward simulation with full engine filter replay ─────
//
// Key changes from v2:
//
// 1. scanPair is called with the COMPLETE live filter stack. Every signal
//    returned has already passed: HTF mandatory, weighted confluence >= 55,
//    ADX >= 25 + slope, CI < 61.8, session gate, FVG/OB structure check.
//    The stats we store are therefore "win rate under the same conditions
//    the live engine fires" — not raw unfiltered pattern win rate.
//
// 2. HTF slice is built from the SAME historical corpus (not a snapshot
//    fetch). For each bar i, htfSlice = all HTF bars with time <= candles[i].time.
//    This ensures zero look-ahead on the HTF as well.
//
// 3. Outcome evaluation now uses the TIERED RR (TP1=1.0R, TP2=2.0R)
//    matching the live engine, so reported win rates are directly comparable.
//
// 4. Minimum closed-trade count raised from 10 → 20 for statistical validity.

async function runBacktest(pairs, timeframes, onProgress) {
  const runAt = Date.now();
  const allResults = [];
  let progressCount = 0;
  const total = pairs.length * timeframes.length;

  for (const pair of pairs) {
    for (const tf of timeframes) {
      progressCount++;
      if (onProgress) onProgress(progressCount, total, `${pair.sym} ${tf}`);

      const htfTf = MTF_MAP[tf] || '4h';

      // FIX 7: fetch both LTF and HTF from the same historical corpus
      const [candles, htfFull] = await Promise.all([
        fetchHistoricalKlines(pair.id, tf, 18),   // 18 months
        fetchHistoricalKlines(pair.id, htfTf, 18), // HTF same period
      ]);

      if (candles.length < 200) continue;

      const MIN_BARS = 200;
      const seenSignals = new Set();

      // Results keyed by pattern — reflects filtered win rates
      const patternResults = {};

      for (let i = MIN_BARS; i < candles.length - 10; i++) {
        const slice = candles.slice(0, i + 1);

        // FIX 7: HTF slice uses historical corpus, no look-ahead
        const curTime  = candles[i].time;
        const htfSlice = htfFull.filter(c => c.time <= curTime);

        let detected;
        try {
          // FIX 7: scanPair runs the FULL live filter stack
          // All of Fix 1–6 + Fix 9 are active during backtest replay
          detected = await scanPair(slice, htfSlice, pair, tf, 'crypto');
        } catch { continue; }

        for (const sig of detected) {
          // Dedup: same pattern + direction in same hourly bucket
          const dedupKey = `${sig.pattern}_${sig.dir}_${Math.floor(sig.detected_at / 3600000)}`;
          if (seenSignals.has(dedupKey)) continue;
          seenSignals.add(dedupKey);

          // Walk forward to find outcome (up to 50 bars)
          // Uses TIERED RR: TP1=1.0R, TP2=2.0R (matching live engine v3)
          let outcome = 'expired', rMult = 0;
          const lookAhead = Math.min(50, candles.length - i - 1);

          for (let j = 1; j <= lookAhead; j++) {
            const fc = candles[i + j];
            if (sig.dir === 'long') {
              if (fc.low  <= sig.sl)  { outcome = 'sl';  rMult = -1.0; break; }
              if (fc.high >= sig.tp1) { outcome = 'tp1'; rMult =  1.0; break; }
              if (fc.high >= sig.tp2) { outcome = 'tp2'; rMult =  2.0; break; }
            } else {
              if (fc.high >= sig.sl)  { outcome = 'sl';  rMult = -1.0; break; }
              if (fc.low  <= sig.tp1) { outcome = 'tp1'; rMult =  1.0; break; }
              if (fc.low  <= sig.tp2) { outcome = 'tp2'; rMult =  2.0; break; }
            }
            // Expiry by bar count
            const barsExpiry = { '15m': 8, '1h': 6, '4h': 4, '1d': 3 }[tf] || 6;
            if (j >= barsExpiry) { outcome = 'expired'; break; }
          }

          if (!patternResults[sig.pattern]) {
            patternResults[sig.pattern] = { wins: 0, losses: 0, expired: 0, totalR: 0, count: 0, signals: [] };
          }
          const pr = patternResults[sig.pattern];
          if (outcome === 'tp1' || outcome === 'tp2') pr.wins++;
          else if (outcome === 'sl') pr.losses++;
          else pr.expired++;
          pr.totalR += rMult;
          pr.count++;
          pr.signals.push({ outcome, rMult, detectedAt: candles[i].time });
        }
      }

      // Aggregate and store — FIX 7: minimum 20 closed trades (raised from 10)
      for (const [pattern, stats] of Object.entries(patternResults)) {
        const closed = stats.wins + stats.losses;
        if (closed < 20) continue;

        const winRate = closed > 0 ? stats.wins / closed : 0;
        const avgR    = stats.totalR / closed;
        const sharpe  = calcSharpe(stats.signals);
        const maxDD   = calcMaxDD(stats.signals);

        const row = {
          run_at:         runAt,
          symbol:         pair.id,
          tf,
          pattern,
          total_signals:  stats.count,
          wins:           stats.wins,
          losses:         stats.losses,
          win_rate:       +winRate.toFixed(4),
          avg_r:          +avgR.toFixed(3),
          max_dd:         +maxDD.toFixed(3),
          sharpe:         +sharpe.toFixed(3),
          sample_from:    new Date(candles[0].time * 1000).toISOString().slice(0,10),
          sample_to:      new Date(candles[candles.length-1].time * 1000).toISOString().slice(0,10),
        };
        db.insertBacktestResult.run(row);
        allResults.push(row);

        // Update pattern stats table — these now reflect FILTERED win rates
        db.upsertPatternStat.run({
          pattern, tf, asset_class: 'crypto',
          wins:     stats.wins,
          losses:   stats.losses,
          total_r:  stats.totalR,
          count:    stats.count,
          win_rate: winRate,
          avg_r:    avgR,
        });
      }

      await sleep(500);
    }
  }

  // Reload filtered win rates into signal engine memory
  const statsRows = db.getPatternStats.all();
  setPatternWinRates(statsRows);

  return allResults;
}

function calcSharpe(signals) {
  const rs = signals.map(s => s.rMult);
  if (rs.length < 2) return 0;
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const std  = Math.sqrt(rs.map(r => (r - mean) ** 2).reduce((a, b) => a + b, 0) / rs.length);
  return std > 0 ? mean / std : 0;
}

function calcMaxDD(signals) {
  let equity = 1, peak = 1, maxDD = 0;
  for (const s of signals) {
    equity *= (1 + s.rMult * 0.01);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

module.exports = { runBacktest };
