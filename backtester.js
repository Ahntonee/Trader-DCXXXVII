'use strict';
const { scanPair, setPatternWinRates } = require('./signal-engine');
const db = require('./db');
const { MTF_MAP } = require('./config');
const { fetchHistoricalKlines, clearHistDeadSet } = require('./data-sources');

// ═══════════════════════════════════════════════════════════════════
// BACKTESTER v3 — Walk-forward, zero look-ahead bias
//
// scanPair is called with the FULL live filter stack (HTF mandatory,
// weighted confluence, ADX/CI regime, session gate, FVG/OB structure).
// Stats stored in DB therefore reflect the SAME conditions the live
// engine fires under — not raw unfiltered pattern detection.
//
// Data fetching is handled entirely by data-sources.js (shared with
// server.js) so any fix or source-order change applies to both.
// ═══════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Round-trip taker fees (~0.1% x2) plus slippage. Override with BACKTEST_COST_PCT.
const _costEnv = parseFloat(process.env.BACKTEST_COST_PCT);
const ROUND_TRIP_COST_PCT = Number.isFinite(_costEnv) && _costEnv >= 0 ? _costEnv : 0.25;

async function runBacktest(pairs, timeframes, onProgress) {
  const runAt = Date.now();
  clearHistDeadSet();

  const allResults    = [];
  let   progressCount = 0;
  const total = pairs.length * timeframes.length;

  // Accumulate stats across ALL pairs per (pattern, tf) so rare patterns
  // still exceed the minimum-closed-trade threshold.
  const aggregated = {};

  for (const pair of pairs) {
    for (const tf of timeframes) {
      progressCount++;
      if (onProgress) onProgress(progressCount, total, `${pair.sym} ${tf}`);

      const htfTf = MTF_MAP[tf] || '4h';

      const [candles, htfFull] = await Promise.all([
        fetchHistoricalKlines(pair.id, tf,    18),
        fetchHistoricalKlines(pair.id, htfTf, 18),
      ]);

      if (candles.length < 200) continue;

      const MIN_BARS    = 200;
      const seenSignals = new Set();
      const patternResults = {};
      const barsExpiry = { '15m': 16, '1h': 24, '4h': 12, '1d': 5 }[tf] || 24;

      for (let i = MIN_BARS; i < candles.length - 10; i++) {
        const slice    = candles.slice(0, i + 1);
        const curTime  = candles[i].time;
        const htfSlice = htfFull.filter(c => c.time <= curTime);

        let detected;
        try {
          // Replay clock = the bar's own timestamp (seconds → ms), so session
          // gates/bonuses and signal ids match what the live engine would
          // have seen at that moment, not the time this backtest is run.
          detected = await scanPair(slice, htfSlice, pair, tf, 'crypto', curTime * 1000);
        } catch { continue; }

        for (const sig of detected) {
          const dedupKey = `${sig.pattern}_${sig.dir}_${Math.floor(sig.detected_at / 3_600_000)}`;
          if (seenSignals.has(dedupKey)) continue;
          seenSignals.add(dedupKey);

          let outcome = 'expired', rMult = 0;
          const lookAhead = Math.min(50, candles.length - i - 1);

          // Payout model matches live trading: the whole position closes at
          // TP1 (+1R) or the stop (-1R). SL is checked first, which is
          // pessimistic when SL and TP1 fall inside the same candle.
          for (let j = 1; j <= lookAhead; j++) {
            const fc = candles[i + j];
            if (sig.dir === 'long') {
              if (fc.low  <= sig.sl)  { outcome = 'sl';  rMult = -1.0; break; }
              if (fc.high >= sig.tp1) { outcome = 'tp1'; rMult =  1.0; break; }
            } else {
              if (fc.high >= sig.sl)  { outcome = 'sl';  rMult = -1.0; break; }
              if (fc.low  <= sig.tp1) { outcome = 'tp1'; rMult =  1.0; break; }
            }
            if (j >= barsExpiry) { outcome = 'expired'; break; }
          }

          // Trading costs (fees + slippage) charged on every filled trade,
          // expressed in R: cost% of price / stop-distance% of price.
          if (outcome === 'tp1' || outcome === 'sl') {
            const riskFrac = Math.abs(sig.entry - sig.sl) / sig.entry;
            if (riskFrac > 0) rMult -= ROUND_TRIP_COST_PCT / 100 / riskFrac;
          }

          if (!patternResults[sig.pattern]) {
            patternResults[sig.pattern] = { wins: 0, losses: 0, expired: 0, totalR: 0, count: 0, signals: [] };
          }
          const pr = patternResults[sig.pattern];
          if (outcome === 'tp1') pr.wins++;
          else if (outcome === 'sl') pr.losses++;
          else pr.expired++;
          pr.totalR += rMult;
          pr.count++;
          pr.signals.push({ outcome, rMult, detectedAt: candles[i].time });
        }
      }

      const sampleFrom = new Date(candles[0].time * 1000).toISOString().slice(0, 10);
      const sampleTo   = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10);

      for (const [pattern, stats] of Object.entries(patternResults)) {
        // Accumulate into cross-pair aggregate
        const key = `${pattern}|${tf}`;
        if (!aggregated[key]) {
          aggregated[key] = { pattern, tf, wins: 0, losses: 0, expired: 0, totalR: 0, count: 0, signals: [], sampleFrom, sampleTo };
        }
        const agg = aggregated[key];
        agg.wins    += stats.wins;
        agg.losses  += stats.losses;
        agg.expired += stats.expired;
        agg.totalR  += stats.totalR;
        agg.count   += stats.count;
        agg.signals.push(...stats.signals);
        if (sampleFrom < agg.sampleFrom) agg.sampleFrom = sampleFrom;
        if (sampleTo   > agg.sampleTo)   agg.sampleTo   = sampleTo;

        // Update live pattern stats (cumulative per-pair upserts)
        const closed = stats.wins + stats.losses;
        db.upsertPatternStat.run({
          pattern, tf, asset_class: 'crypto',
          wins:     stats.wins,
          losses:   stats.losses,
          total_r:  stats.totalR,
          count:    stats.count,
          win_rate: closed > 0 ? stats.wins / closed : 0,
          avg_r:    closed > 0 ? stats.totalR / closed : 0,
        });
      }

      await sleep(500);
    }
  }

  // Store one aggregated backtest_results row per (pattern, tf).
  // Minimum 5 closed trades across all pairs — much easier to achieve than
  // 10 per-pair, and statistically sound when patterns are rare per symbol.
  for (const stats of Object.values(aggregated)) {
    const closed = stats.wins + stats.losses;
    if (closed < 5) continue;

    const winRate = stats.wins / closed;
    const avgR    = stats.totalR / closed;
    const sharpe  = calcSharpe(stats.signals);
    const maxDD   = calcMaxDD(stats.signals);

    const row = {
      run_at:        runAt,
      symbol:        'ALL',
      tf:            stats.tf,
      pattern:       stats.pattern,
      total_signals: stats.count,
      wins:          stats.wins,
      losses:        stats.losses,
      win_rate:      +winRate.toFixed(4),
      avg_r:         +avgR.toFixed(3),
      max_dd:        +maxDD.toFixed(3),
      sharpe:        +sharpe.toFixed(3),
      sample_from:   stats.sampleFrom,
      sample_to:     stats.sampleTo,
    };
    db.insertBacktestResult.run(row);
    allResults.push(row);
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
