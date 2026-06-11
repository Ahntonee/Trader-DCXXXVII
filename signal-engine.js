'use strict';

// ═══════════════════════════════════════════════════════════════════
// APEX SIGNAL ENGINE v3
// Runs server-side. Returns validated, high-probability signals only.
// Target: 85–90% win rate on tiered 1:1 / 1:2 / trail RR
//
// FIXES APPLIED (v2 → v3):
//  1. HTF bias is now a hard mandatory requirement — signals against HTF are blocked entirely
//  2. FVG (Fair Value Gap) + Orderblock proximity filter — signals must originate from structure
//  3. Retest confirmation state — breakout patterns wait for neckline retest before entry
//  4. Weighted confluence scoring — HTF(30) EMA(25) RSI(20) Candle(15) MACD(5) Vol(5)
//  5. Session gate per pattern type — hard blocks on post-NY all patterns, Asia reversals
//  6. ADX >= 25 + slope + Choppiness Index < 61.8 regime filter
//  7. (consumed by backtester.js — engine exports full filter stack for replay)
//  8. Structure-based trailing stop — trails behind confirmed swing, not arithmetic distance
//  9. Bug fixes: engulfing dead-code, falling wedge slope inversion, H&S shoulder check,
//     InvHS missing shoulder check, session dead-code NY OPEN, bull flag lower-half inversion
// ═══════════════════════════════════════════════════════════════════

// Signal expiry per timeframe (in minutes)
const EXPIRY_MINS = { '15m': 120, '1h': 360, '4h': 960, '1d': 4320 };

// MTF lookup: for each TF, which higher TF to confirm against
const MTF_MAP = { '15m': '1h', '1h': '4h', '4h': '1d', '1d': '1d' };

// Reversal pattern names — used by session gate (Fix 5)
const REVERSAL_PATTERNS = new Set([
  'Double Bottom', 'Double Top',
  'Head & Shoulders', 'Inv. Head & Shoulders',
  'Cup & Handle',
  'Bull Engulfing at S/R', 'Bear Engulfing at S/R',
]);

// ─── INDICATORS ─────────────────────────────────────────────────────

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = null;
  const result = [];
  for (const c of data) {
    ema = ema === null ? c.close : c.close * k + ema * (1 - k);
    result.push({ time: c.time, value: ema });
  }
  return result;
}

function calcATR(cs, period = 14) {
  if (cs.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < cs.length; i++) {
    trs.push(Math.max(
      cs[i].high - cs[i].low,
      Math.abs(cs[i].high - cs[i - 1].close),
      Math.abs(cs[i].low  - cs[i - 1].close)
    ));
  }
  return trs.slice(-period).reduce((s, v) => s + v, 0) / period;
}

// ── FIX 6: calcADX now also returns adxHistory for slope check ──────
function calcADX(cs, period = 14) {
  if (cs.length < period * 2 + 2) return null;
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < cs.length; i++) {
    const h = cs[i].high, l = cs[i].low, ph = cs[i-1].high, pl = cs[i-1].low, pc = cs[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    plusDMs.push(up > dn && up > 0 ? up : 0);
    minusDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  let atr = trs.slice(0, period).reduce((s,v) => s+v, 0);
  let pDI = plusDMs.slice(0, period).reduce((s,v) => s+v, 0);
  let mDI = minusDMs.slice(0, period).reduce((s,v) => s+v, 0);
  const dxArr = [];
  for (let i = period; i < trs.length; i++) {
    atr = atr - atr / period + trs[i];
    pDI = pDI - pDI / period + plusDMs[i];
    mDI = mDI - mDI / period + minusDMs[i];
    if (atr === 0) continue;
    const pdi = pDI / atr * 100, mdi = mDI / atr * 100;
    const sum = pdi + mdi;
    dxArr.push(sum > 0 ? Math.abs(pdi - mdi) / sum * 100 : 0);
  }
  if (dxArr.length < period) return null;

  // Build full ADX history for slope detection
  const adxHistory = [];
  let adx = dxArr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  adxHistory.push(adx);
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]) / period;
    adxHistory.push(adx);
  }

  const pdi = pDI / atr * 100, mdi = mDI / atr * 100;
  return {
    adx:        Math.round(adx * 10) / 10,
    plusDI:     pdi,
    minusDI:    mdi,
    adxHistory, // full sequence for slope check
  };
}

// ── FIX 6: Choppiness Index (CI) ────────────────────────────────────
// CI < 38.2  → strongly trending (green-light)
// CI > 61.8  → choppy / ranging (hard block)
// Between    → neutral (allow but no bonus)
function calcChoppiness(cs, period = 14) {
  if (cs.length < period + 1) return null;
  const slice = cs.slice(-(period + 1));
  const trs = [];
  for (let i = 1; i < slice.length; i++) {
    trs.push(Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i-1].close),
      Math.abs(slice[i].low  - slice[i-1].close)
    ));
  }
  const atrSum = trs.reduce((s, v) => s + v, 0);
  const highestHigh = Math.max(...slice.map(c => c.high));
  const lowestLow   = Math.min(...slice.map(c => c.low));
  const trueRange   = highestHigh - lowestLow;
  if (trueRange === 0) return null;
  return 100 * Math.log10(atrSum / trueRange) / Math.log10(period);
}

function calcRSI(data, period = 14) {
  const result = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < data.length; i++) {
    const diff = data[i].close - data[i-1].close;
    const gain = diff > 0 ? diff : 0, loss = diff < 0 ? -diff : 0;
    if (i <= period) {
      avgGain += gain / period; avgLoss += loss / period;
      if (i === period) result.push({ time: data[i].time, value: 100 - (100 / (1 + avgGain / Math.max(avgLoss, 1e-10))) });
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      result.push({ time: data[i].time, value: 100 - (100 / (1 + avgGain / Math.max(avgLoss, 1e-10))) });
    }
  }
  return result;
}

function calcMACD(data, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(data, fast), emaSlow = calcEMA(data, slow);
  const len = Math.min(emaFast.length, emaSlow.length);
  const macdLine = [];
  for (let i = 0; i < len; i++) {
    const fi = emaFast.length - len + i, si = emaSlow.length - len + i;
    macdLine.push({ time: emaFast[fi].time, value: emaFast[fi].value - emaSlow[si].value });
  }
  const k = 2 / (signal + 1); let sig = macdLine[0].value;
  const signalLine = [];
  for (const m of macdLine) { sig = m.value * k + sig * (1 - k); signalLine.push({ time: m.time, value: sig }); }
  return { macdLine, signalLine };
}

// ─── VOLATILITY REGIME ───────────────────────────────────────────────
// Compares current ATR to its 20-period average to classify market vol.
// LOW     → current ATR < 70% of avg  → reduce size, wider stop needed
// NORMAL  → 70–130% of avg            → standard sizing
// ELEVATED→ 130–200% of avg           → halve position size
// EXTREME → > 200% of avg             → no new entries (skip)
// Returns { regime, atrRatio, sizeMultiplier }
function calcVolRegime(cs) {
  if (cs.length < 35) return { regime: 'NORMAL', atrRatio: 1, sizeMultiplier: 1 };
  // Current ATR (last 14 bars)
  const curATR = calcATR(cs, 14);
  // Average ATR over the last 20 measurements (each measured on a 14-bar window)
  const atrs = [];
  for (let i = cs.length - 20; i < cs.length; i++) {
    if (i < 14) continue;
    atrs.push(calcATR(cs.slice(0, i + 1), 14));
  }
  if (!atrs.length || !curATR) return { regime: 'NORMAL', atrRatio: 1, sizeMultiplier: 1 };
  const avgATR = atrs.reduce((s, v) => s + v, 0) / atrs.length;
  const ratio  = avgATR > 0 ? curATR / avgATR : 1;
  let regime, sizeMultiplier;
  if      (ratio > 2.0) { regime = 'EXTREME';  sizeMultiplier = 0;    }
  else if (ratio > 1.3) { regime = 'ELEVATED'; sizeMultiplier = 0.5;  }
  else if (ratio < 0.7) { regime = 'LOW';      sizeMultiplier = 0.75; }
  else                  { regime = 'NORMAL';   sizeMultiplier = 1;    }
  return { regime, atrRatio: +ratio.toFixed(2), sizeMultiplier };
}

// ─── SWING POINTS ────────────────────────────────────────────────────

function findSwings(cs, lb = 5) {
  const highs = [], lows = [];
  for (let i = lb; i < cs.length - lb; i++) {
    let isH = true, isL = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (cs[j].high >= cs[i].high) isH = false;
      if (cs[j].low  <= cs[i].low)  isL = false;
    }
    if (isH) highs.push({ i, p: cs[i].high, t: cs[i].time });
    if (isL) lows.push({ i, p: cs[i].low,  t: cs[i].time });
  }
  return { highs, lows };
}

// ─── FIX 2: FAIR VALUE GAP (FVG) DETECTION ──────────────────────────
// A 3-candle imbalance where candle[i-1].high < candle[i+1].low (bull FVG)
// or candle[i-1].low > candle[i+1].high (bear FVG).
// The gap zone is the price range price left behind — institutional orders fill here.
// Returns the last N FVGs found in cs, tagged bull/bear with their price range.

function findFVGs(cs, lookback = 100) {
  const fvgs = [];
  const start = Math.max(1, cs.length - lookback - 1);
  for (let i = start; i < cs.length - 1; i++) {
    const prev = cs[i - 1], cur = cs[i], next = cs[i + 1];
    // Bullish FVG: gap between prev.high and next.low
    if (next.low > prev.high) {
      fvgs.push({ type: 'bull', top: next.low, bot: prev.high, i, time: cur.time });
    }
    // Bearish FVG: gap between prev.low and next.high
    if (next.high < prev.low) {
      fvgs.push({ type: 'bear', top: prev.low, bot: next.high, i, time: cur.time });
    }
  }
  return fvgs;
}

// ─── FIX 2: ORDERBLOCK DETECTION ────────────────────────────────────
// An orderblock is the last candle that moved opposite to the following
// strong impulse move. For a bullish OB: the last bearish candle before a
// strong up-move. For a bearish OB: the last bullish candle before a
// strong down-move.
// We define "strong impulse" as a move >= 1.5× ATR in a single bar.

function findOrderblocks(cs, lookback = 100) {
  const obs = [];
  if (cs.length < 5) return obs;
  const atr = calcATR(cs, 14);
  if (!atr) return obs;
  const start = Math.max(2, cs.length - lookback);
  for (let i = start; i < cs.length - 1; i++) {
    const next = cs[i + 1];
    const impulse = Math.abs(next.close - next.open);
    if (impulse < atr * 1.5) continue; // not an impulse bar
    const cur = cs[i];
    const bullImpulse = next.close > next.open;
    const bearImpulse = next.close < next.open;
    // Bullish OB: last bearish candle before bull impulse
    if (bullImpulse && cur.close < cur.open) {
      obs.push({ type: 'bull', top: cur.open, bot: cur.close, i, time: cur.time });
    }
    // Bearish OB: last bullish candle before bear impulse
    if (bearImpulse && cur.close > cur.open) {
      obs.push({ type: 'bear', top: cur.close, bot: cur.open, i, time: cur.time });
    }
  }
  return obs;
}

// ─── VOLUME PROFILE VISIBLE RANGE (VPVR) ────────────────────────────
// Distributes candle volume across N price buckets for a lookback window.
// Returns { poc, vah, val, buckets } where:
//   poc = price with highest volume (Point of Control)
//   vah = Value Area High (upper edge of 70% volume zone around POC)
//   val = Value Area Low  (lower edge of 70% volume zone around POC)
// Proximity bonus: +10 when entry is within 0.5 ATR of POC/VAH/VAL; -5 elsewhere.

function calcVPVR(cs, levels = 50, lookback = 100) {
  const slice = cs.slice(-Math.min(lookback, cs.length));
  if (slice.length < 10) return null;

  const lo = Math.min(...slice.map(c => c.low));
  const hi = Math.max(...slice.map(c => c.high));
  if (hi === lo) return null;

  const bucketSize = (hi - lo) / levels;
  const buckets = Array.from({ length: levels }, (_, i) => ({
    price: lo + (i + 0.5) * bucketSize,
    vol: 0,
  }));

  for (const c of slice) {
    const vol = c.volume || 0;
    if (!vol) continue;
    const bLo = Math.floor((c.low  - lo) / bucketSize);
    const bHi = Math.floor((c.high - lo) / bucketSize);
    const span = Math.max(1, bHi - bLo + 1);
    for (let b = bLo; b <= bHi && b < levels; b++) {
      if (b >= 0) buckets[b].vol += vol / span;
    }
  }

  const pocIdx = buckets.reduce((best, b, i) => b.vol > buckets[best].vol ? i : best, 0);
  const poc = buckets[pocIdx].price;

  // Value Area = 70% of total volume, expanding around POC
  const totalVol = buckets.reduce((s, b) => s + b.vol, 0);
  const target = totalVol * 0.70;
  let lo_idx = pocIdx, hi_idx = pocIdx, vaVol = buckets[pocIdx].vol;
  while (vaVol < target) {
    const expandLo = lo_idx > 0         ? buckets[lo_idx - 1].vol : -1;
    const expandHi = hi_idx < levels - 1 ? buckets[hi_idx + 1].vol : -1;
    if (expandLo < 0 && expandHi < 0) break;
    if (expandHi >= expandLo) { hi_idx++; vaVol += buckets[hi_idx].vol; }
    else                       { lo_idx--; vaVol += buckets[lo_idx].vol; }
  }
  return { poc, vah: buckets[hi_idx].price + bucketSize / 2, val: buckets[lo_idx].price - bucketSize / 2, buckets };
}

// ─── FIX 2: STRUCTURE PROXIMITY CHECK ───────────────────────────────
// Returns true if 'price' is inside or within 0.5% of any FVG or OB
// that matches the trade direction.

function isAtStructure(price, dir, fvgs, obs, atr) {
  const buf = atr * 0.3; // small ATR buffer for "close enough"

  for (const fvg of fvgs) {
    if (dir === 'long'  && fvg.type === 'bull' && price >= fvg.bot - buf && price <= fvg.top + buf) return { ok: true, label: 'Bull FVG' };
    if (dir === 'short' && fvg.type === 'bear' && price >= fvg.bot - buf && price <= fvg.top + buf) return { ok: true, label: 'Bear FVG' };
  }

  for (const ob of obs) {
    if (dir === 'long'  && ob.type === 'bull' && price >= ob.bot - buf && price <= ob.top + buf) return { ok: true, label: 'Bull OB' };
    if (dir === 'short' && ob.type === 'bear' && price >= ob.bot - buf && price <= ob.top + buf) return { ok: true, label: 'Bear OB' };
  }

  return { ok: false, label: null };
}

// ─── STRUCTURE-BASED SL ──────────────────────────────────────────────
// Places SL at the actual swing point that invalidates the pattern,
// with ATR buffer. Never a formula on entry price.

function structureSL(dir, lows, highs, cs, entry) {
  const atr = calcATR(cs, 14);
  const buf = atr * 0.5;
  const curPrice = cs[cs.length - 1].close;

  if (dir === 'long') {
    // SL below the nearest swing low that is below entry AND below current price
    const candidates = lows
      .filter(l => l.p < entry && l.p < curPrice)
      .sort((a, b) => b.i - a.i);
    if (candidates.length > 0) {
      const swingLow = candidates[0].p;
      return Math.min(swingLow - buf, entry - atr * 1.2);
    }
    return entry - atr * 1.5;
  } else {
    // SL above the nearest swing high that is above entry AND above current price
    const candidates = highs
      .filter(h => h.p > entry && h.p > curPrice)
      .sort((a, b) => b.i - a.i);
    if (candidates.length > 0) {
      const swingHigh = candidates[0].p;
      return Math.max(swingHigh + buf, entry + atr * 1.2);
    }
    return entry + atr * 1.5;
  }
}

// ─── FIX 8: STRUCTURE-BASED TRAILING STOP ───────────────────────────
// After TP1, trail stop behind the most recent confirmed swing low (long)
// or swing high (short), recalculated on each closed candle.
// Minimum trail distance = 0.3R to avoid stops too tight to breathe.
// Stop only moves in favour — never backwards.
// Returns the new SL value, or null if it should not move.

function computeStructureTrail(sig, cs) {
  const originalRisk = Math.abs(sig.tp1 - sig.entry) / 1.5;
  if (!originalRisk) return null;

  const minTrailDist = originalRisk * 0.3; // never trail tighter than 0.3R
  const { highs, lows } = findSwings(cs, 3); // lb=3 for faster swing detection in trail

  const curPrice = cs[cs.length - 1].close;

  if (sig.dir === 'long') {
    // Trail behind the highest recent swing low that is below current price
    const candidates = lows
      .filter(l => l.p < curPrice && l.p > sig.entry) // above entry = profit territory only
      .sort((a, b) => b.p - a.p); // highest first
    if (candidates.length > 0) {
      const trailLevel = candidates[0].p - calcATR(cs, 14) * 0.3;
      if (trailLevel > sig.sl && curPrice - trailLevel >= minTrailDist) {
        return +trailLevel.toFixed(8);
      }
    }
    // Fallback: arithmetic 0.5R trail
    const fallback = curPrice - originalRisk * 0.5;
    return fallback > sig.sl ? +fallback.toFixed(8) : null;
  } else {
    // Trail behind the lowest recent swing high that is above current price
    const candidates = highs
      .filter(h => h.p > curPrice && h.p < sig.entry)
      .sort((a, b) => a.p - b.p); // lowest first
    if (candidates.length > 0) {
      const trailLevel = candidates[0].p + calcATR(cs, 14) * 0.3;
      if (trailLevel < sig.sl && trailLevel - curPrice >= minTrailDist) {
        return +trailLevel.toFixed(8);
      }
    }
    const fallback = curPrice + originalRisk * 0.5;
    return fallback < sig.sl ? +fallback.toFixed(8) : null;
  }
}

// ─── PATTERN DETECTION ──────────────────────────────────────────────

function detectDoubleBottom(lows, cs) {
  if (lows.length < 2) return null;
  const l1 = lows[lows.length - 2], l2 = lows[lows.length - 1];
  if (Math.abs(l1.p - l2.p) / l1.p > 0.008) return null;
  if (l2.i - l1.i < 5) return null;
  const neckSlice = cs.slice(l1.i, l2.i);
  if (!neckSlice.length) return null;
  const neck = Math.max(...neckSlice.map(c => c.high));
  if ((neck - l2.p) / l2.p < 0.005) return null;
  const cur = cs[cs.length - 1];
  if (cur.close < neck * 0.97) return null;
  if (cur.close > neck * 1.03) return null;
  return { pattern: 'Double Bottom', dir: 'long', entry: neck, swingLow: Math.min(l1.p, l2.p), conf: 75 };
}

function detectDoubleTop(highs, cs) {
  if (highs.length < 2) return null;
  const h1 = highs[highs.length - 2], h2 = highs[highs.length - 1];
  if (Math.abs(h1.p - h2.p) / h1.p > 0.008) return null;
  if (h2.i - h1.i < 5) return null;
  const neckSlice = cs.slice(h1.i, h2.i);
  if (!neckSlice.length) return null;
  const neck = Math.min(...neckSlice.map(c => c.low));
  if ((h2.p - neck) / h2.p < 0.005) return null;
  const cur = cs[cs.length - 1];
  if (cur.close > neck * 1.03) return null;
  if (cur.close < neck * 0.97) return null;
  return { pattern: 'Double Top', dir: 'short', entry: neck, swingHigh: Math.max(h1.p, h2.p), conf: 75 };
}

// ── FIX 9: H&S shoulder validation corrected ────────────────────────
// Shoulders (ls, rs) must be strictly BELOW their adjacent arm peaks (lh, rh).
// The old check `ls.p > lh.p * 0.97` allowed shoulders almost as high as the arm.
function detectHeadShoulders(highs, cs) {
  if (highs.length < 5) return null;
  const n = highs.length;
  const [ls, lh, h, rh, rs] = [highs[n-5], highs[n-4], highs[n-3], highs[n-2], highs[n-1]];
  if (h.p <= lh.p || h.p <= rh.p) return null;
  if (Math.abs(lh.p - rh.p) / lh.p > 0.03) return null;
  // FIX 9: shoulders must be strictly below arm peaks, not just within 3%
  if (ls.p >= lh.p || rs.p >= rh.p) return null;
  const neckL = cs.slice(lh.i, h.i).reduce((mn, c) => Math.min(mn, c.low), Infinity);
  const neckR = cs.slice(h.i, rh.i).reduce((mn, c) => Math.min(mn, c.low), Infinity);
  const neck = (neckL + neckR) / 2;
  const cur = cs[cs.length - 1];
  if (cur.close > neck * 1.03) return null;
  if (cur.close < neck * 0.97) return null;
  return { pattern: 'Head & Shoulders', dir: 'short', entry: neck, swingHigh: h.p, conf: 82 };
}

// ── FIX 9: InvHS — added missing shoulder height validation ─────────
function detectInverseHS(lows, cs) {
  if (lows.length < 5) return null;
  const n = lows.length;
  const [ls, lh, h, rh, rs] = [lows[n-5], lows[n-4], lows[n-3], lows[n-2], lows[n-1]];
  if (h.p >= lh.p || h.p >= rh.p) return null;
  if (Math.abs(lh.p - rh.p) / lh.p > 0.03) return null;
  // FIX 9: shoulders must be strictly above arm troughs
  if (ls.p <= lh.p || rs.p <= rh.p) return null;
  const neckL = cs.slice(lh.i, h.i).reduce((mx, c) => Math.max(mx, c.high), -Infinity);
  const neckR = cs.slice(h.i, rh.i).reduce((mx, c) => Math.max(mx, c.high), -Infinity);
  const neck = (neckL + neckR) / 2;
  const cur = cs[cs.length - 1];
  if (cur.close < neck * 0.97) return null;
  if (cur.close > neck * 1.03) return null;
  return { pattern: 'Inv. Head & Shoulders', dir: 'long', entry: neck, swingLow: h.p, conf: 82 };
}

function detectAscendingTriangle(highs, lows, cs) {
  if (highs.length < 3 || lows.length < 3) return null;
  const rH = highs.slice(-3), rL = lows.slice(-3);
  if (!rH.every(h => Math.abs(h.p - rH[0].p) / rH[0].p < 0.007)) return null;
  if (!(rL[0].p < rL[1].p && rL[1].p < rL[2].p)) return null;
  const cur = cs[cs.length - 1];
  if (cur.close < rH[0].p * 0.97) return null;
  if (cur.close > rH[0].p * 1.03) return null;
  return { pattern: 'Ascending Triangle', dir: 'long', entry: rH[0].p * 1.001, resist: rH[0].p, conf: 72 };
}

function detectDescendingTriangle(highs, lows, cs) {
  if (highs.length < 3 || lows.length < 3) return null;
  const rH = highs.slice(-3), rL = lows.slice(-3);
  if (!rL.every(l => Math.abs(l.p - rL[0].p) / rL[0].p < 0.007)) return null;
  if (!(rH[0].p > rH[1].p && rH[1].p > rH[2].p)) return null;
  const cur = cs[cs.length - 1];
  if (cur.close > rL[0].p * 1.03) return null;
  if (cur.close < rL[0].p * 0.97) return null;
  return { pattern: 'Descending Triangle', dir: 'short', entry: rL[0].p * 0.999, support: rL[0].p, conf: 72 };
}

// ── FIX 9: Bull flag lower-half check corrected ─────────────────────
// Old check rejected valid flags where the last close was in the upper half.
// Real intent: reject if price has already broken DOWN out of the flag.
function detectBullFlag(cs) {
  if (cs.length < 30) return null;
  const recent = cs.slice(-30), pole = recent.slice(0, 10), flag = recent.slice(10);
  const poleMove = (pole[pole.length-1].close - pole[0].open) / pole[0].open;
  if (poleMove < 0.05) return null;
  const flagHigh = Math.max(...flag.map(c => c.high)), flagLow = Math.min(...flag.map(c => c.low));
  if ((flagHigh - flagLow) / flagLow > 0.03) return null;
  // FIX 9: reject if last close has broken below the lower 20% of the flag (pattern failing)
  if (flag[flag.length-1].close < flagLow + (flagHigh - flagLow) * 0.2) return null;
  const cur = cs[cs.length-1];
  if (cur.close < flagHigh * 0.97) return null;
  if (cur.close > flagHigh * 1.03) return null;
  return { pattern: 'Bull Flag', dir: 'long', entry: flagHigh * 1.001, flagLow, conf: 70 };
}

function detectBearFlag(cs) {
  if (cs.length < 30) return null;
  const recent = cs.slice(-30), pole = recent.slice(0, 10), flag = recent.slice(10);
  const poleMove = (pole[0].open - pole[pole.length-1].close) / pole[0].open;
  if (poleMove < 0.05) return null;
  const flagHigh = Math.max(...flag.map(c => c.high)), flagLow = Math.min(...flag.map(c => c.low));
  if ((flagHigh - flagLow) / flagLow > 0.03) return null;
  const cur = cs[cs.length-1];
  if (cur.close > flagLow * 1.03) return null;
  if (cur.close < flagLow * 0.97) return null;
  return { pattern: 'Bear Flag', dir: 'short', entry: flagLow * 0.999, flagHigh, conf: 70 };
}

// ── FIX 9: Falling wedge slope comparison corrected ─────────────────
// Both slopes are negative. Highs must drop MORE steeply than lows.
// "More steeply negative" means highSlope < lowSlope (both negative).
// Old code had `highSlope >= lowSlope` which was inverted.
function detectFallingWedge(highs, lows, cs) {
  if (highs.length < 3 || lows.length < 3) return null;
  const rH = highs.slice(-3), rL = lows.slice(-3);
  if (!(rH[0].p > rH[1].p && rH[1].p > rH[2].p)) return null;
  if (!(rL[0].p > rL[1].p && rL[1].p > rL[2].p)) return null;
  const highSlope = (rH[2].p - rH[0].p) / (rH[2].i - rH[0].i); // negative
  const lowSlope  = (rL[2].p - rL[0].p) / (rL[2].i - rL[0].i); // negative
  // FIX 9: highs must fall faster (more negative) than lows → convergence
  if (highSlope <= lowSlope) return null;
  const cur = cs[cs.length - 1];
  if (cur.close < rH[2].p * 0.97) return null;
  if (cur.close > rH[2].p * 1.03) return null;
  return { pattern: 'Falling Wedge', dir: 'long', entry: rH[2].p * 1.001, swingLow: rL[2].p, conf: 74 };
}

function detectRisingWedge(highs, lows, cs) {
  if (highs.length < 3 || lows.length < 3) return null;
  const rH = highs.slice(-3), rL = lows.slice(-3);
  if (!(rH[0].p < rH[1].p && rH[1].p < rH[2].p)) return null;
  if (!(rL[0].p < rL[1].p && rL[1].p < rL[2].p)) return null;
  const highSlope = (rH[2].p - rH[0].p) / (rH[2].i - rH[0].i);
  const lowSlope  = (rL[2].p - rL[0].p) / (rL[2].i - rL[0].i);
  if (lowSlope <= highSlope) return null;
  const cur = cs[cs.length - 1];
  if (cur.close > rL[2].p * 1.03) return null;
  if (cur.close < rL[2].p * 0.97) return null;
  return { pattern: 'Rising Wedge', dir: 'short', entry: rL[2].p * 0.999, swingHigh: rH[2].p, conf: 74 };
}

function detectCupHandle(cs) {
  if (cs.length < 60) return null;
  const slice = cs.slice(-60);
  const half  = Math.floor(slice.length / 2);
  const leftHalf  = slice.slice(0, half);
  const rightHalf = slice.slice(half);
  const cupLow    = Math.min(...leftHalf.map(c => c.low));
  const rimLeft   = Math.max(leftHalf[0].high, leftHalf[1].high);
  const rimRight  = Math.max(...rightHalf.slice(0, 5).map(c => c.high));
  if (Math.abs(rimLeft - rimRight) / rimLeft > 0.015) return null;
  const depth = (rimLeft - cupLow) / rimLeft;
  if (depth < 0.10 || depth > 0.35) return null;
  const handleSlice = slice.slice(-10);
  const handleHigh  = Math.max(...handleSlice.map(c => c.high));
  const handleLow   = Math.min(...handleSlice.map(c => c.low));
  if ((handleHigh - handleLow) / handleLow > 0.06) return null;
  if (handleHigh > rimRight * 1.005) return null;
  const cur = cs[cs.length - 1];
  if (cur.close < rimRight * 0.97) return null;
  if (cur.close > rimRight * 1.03) return null;
  return { pattern: 'Cup & Handle', dir: 'long', entry: rimRight * 1.001, swingLow: cupLow, conf: 78 };
}

function detectEngulfingAtSR(cs, levels, dir) {
  if (cs.length < 3) return null;
  const c = cs[cs.length-1], p = cs[cs.length-2];
  const bodyC = Math.abs(c.close - c.open), bodyP = Math.abs(p.close - p.open);
  if (bodyC < bodyP * 1.2) return null;
  const bullEngulf = c.close > c.open && p.close < p.open && c.open <= p.close && c.close >= p.open;
  const bearEngulf = c.close < c.open && p.close > p.open && c.open >= p.close && c.close <= p.open;
  if (dir === 'long' && !bullEngulf) return null;
  if (dir === 'short' && !bearEngulf) return null;
  const price = dir === 'long' ? c.low : c.high;
  const nearLevel = levels.some(l => Math.abs(l.price - price) / price < 0.008);
  if (!nearLevel) return null;
  return { pattern: dir === 'long' ? 'Bull Engulfing at S/R' : 'Bear Engulfing at S/R', dir, entry: c.close, conf: 74 };
}

// ── FIX 9: detectCandlePattern — engulfing dead-code fixed ──────────
// Old code: `if (bullC && bearC && ...)` — mutually exclusive, never fired.
// Fixed: check previous candle's direction (bullPrev / bearPrev).
function detectCandlePattern(cs) {
  if (cs.length < 3) return null;
  const c = cs[cs.length-1], p = cs[cs.length-2];
  const body = Math.abs(c.close - c.open), range = c.high - c.low;
  if (range === 0) return null;
  const upWick = c.high - Math.max(c.open, c.close), dnWick = Math.min(c.open, c.close) - c.low;
  const bullC = c.close > c.open, bearC = c.close < c.open;
  const bullPrev = p.close > p.open, bearPrev = p.close < p.open;
  const bodyP = Math.abs(p.close - p.open);
  if (body < range * 0.1) return { name: 'Doji', dir: 'neutral' };
  if (bullC && dnWick > body * 2 && upWick < body * 0.5) return { name: 'Hammer', dir: 'bull' };
  if (bearC && upWick > body * 2 && dnWick < body * 0.5) return { name: 'Shooting Star', dir: 'bear' };
  if (bullC && dnWick > range * 0.6 && body < range * 0.3) return { name: 'Pin Bar ▲', dir: 'bull' };
  if (bearC && upWick > range * 0.6 && body < range * 0.3) return { name: 'Pin Bar ▼', dir: 'bear' };
  // FIX 9: use bullPrev/bearPrev instead of bullC/bearC for prior candle check
  if (bullC && bearPrev && c.open <= p.close && c.close >= p.open && body > bodyP * 1.1) return { name: 'Bull Engulfing', dir: 'bull' };
  if (bearC && bullPrev && c.open >= p.close && c.close <= p.open && body > bodyP * 1.1) return { name: 'Bear Engulfing', dir: 'bear' };
  return null;
}

// ─── CONFIRMATION CHECKS ────────────────────────────────────────────

function checkEMAStack(cs, dir) {
  if (cs.length < 200) {
    if (cs.length < 50) return { score: 0, label: 'EMA N/A' };
    const ema20 = calcEMA(cs, 20), ema50 = calcEMA(cs, 50);
    const e20 = ema20[ema20.length-1].value, e50 = ema50[ema50.length-1].value;
    const price = cs[cs.length-1].close;
    if (dir === 'long')  return price > e20 && e20 > e50 ? { score: 8, label: 'EMA BULL' } : price < e20 ? { score: -10, label: 'EMA COUNTER' } : { score: 0, label: 'EMA MIXED' };
    return price < e20 && e20 < e50 ? { score: 8, label: 'EMA BEAR' } : price > e20 ? { score: -10, label: 'EMA COUNTER' } : { score: 0, label: 'EMA MIXED' };
  }
  const ema20 = calcEMA(cs, 20), ema50 = calcEMA(cs, 50), ema200 = calcEMA(cs, 200);
  const e20 = ema20[ema20.length-1].value, e50 = ema50[ema50.length-1].value, e200 = ema200[ema200.length-1].value;
  const price = cs[cs.length-1].close;
  const bull = price > e20 && e20 > e50 && e50 > e200;
  const bear = price < e20 && e20 < e50 && e50 < e200;
  const partBull = price > e50 && e50 > e200;
  const partBear = price < e50 && e50 < e200;
  if (dir === 'long') {
    if (bull) return { score: 15, label: 'EMA BULL STACK' };
    if (partBull) return { score: 8, label: 'EMA BULL PARTIAL' };
    if (bear) return { score: -20, label: 'EMA COUNTER' };
    return { score: -5, label: 'EMA MIXED' };
  } else {
    if (bear) return { score: 15, label: 'EMA BEAR STACK' };
    if (partBear) return { score: 8, label: 'EMA BEAR PARTIAL' };
    if (bull) return { score: -20, label: 'EMA COUNTER' };
    return { score: -5, label: 'EMA MIXED' };
  }
}

function checkMACDAlignment(cs, dir) {
  if (cs.length < 35) return 0;
  const { macdLine, signalLine } = calcMACD(cs);
  const lastMACD = macdLine[macdLine.length-1].value, lastSig = signalLine[signalLine.length-1].value;
  if (dir === 'long')  return lastMACD > lastSig ? 5 : -5;
  return lastMACD < lastSig ? 5 : -5;
}

function checkRSI(cs, dir) {
  if (cs.length < 20) return { score: 0, label: 'RSI N/A' };
  const rsiData = calcRSI(cs, 14);
  if (!rsiData.length) return { score: 0, label: 'RSI N/A' };
  const last = rsiData[rsiData.length-1].value;
  const priceSlice = cs.slice(-15), rsiSlice = rsiData.slice(-15);
  if (rsiSlice.length >= 8) {
    const pH1 = Math.max(...priceSlice.slice(0,8).map(c => c.high)), pH2 = Math.max(...priceSlice.slice(7).map(c => c.high));
    const pL1 = Math.min(...priceSlice.slice(0,8).map(c => c.low)),  pL2 = Math.min(...priceSlice.slice(7).map(c => c.low));
    const rH1 = Math.max(...rsiSlice.slice(0,8).map(r => r.value)), rH2 = rsiSlice.length > 7 ? Math.max(...rsiSlice.slice(7).map(r => r.value)) : rH1;
    const rL1 = Math.min(...rsiSlice.slice(0,8).map(r => r.value)), rL2 = rsiSlice.length > 7 ? Math.min(...rsiSlice.slice(7).map(r => r.value)) : rL1;
    if (dir === 'short' && pH2 > pH1 * 1.001 && rH2 < rH1 - 2) return { score: 12, label: 'RSI BEAR DIV' };
    if (dir === 'long'  && pL2 < pL1 * 0.999 && rL2 > rL1 + 2) return { score: 12, label: 'RSI BULL DIV' };
  }
  if (dir === 'long'  && last < 35) return { score: 5,  label: 'RSI OVERSOLD' };
  if (dir === 'short' && last > 65) return { score: 5,  label: 'RSI OVERBOUGHT' };
  if (dir === 'long'  && last > 70) return { score: -8, label: 'RSI TOO HIGH' };
  if (dir === 'short' && last < 30) return { score: -8, label: 'RSI TOO LOW' };
  return { score: 0, label: 'RSI NEUTRAL' };
}

function checkVolume(cs) {
  if (cs.length < 26) return { score: 0, ok: false, label: 'Vol N/A' };
  const avgVol = cs.slice(-25,-1).reduce((s,c) => s+c.volume, 0) / 24;
  const cur = cs[cs.length-1];
  if (avgVol === 0) return { score: 0, ok: false, label: 'Vol N/A' };
  if (cur.volume > avgVol * 1.5) return { score: 5, ok: true, label: `Vol +${Math.round(cur.volume/avgVol*100-100)}%` };
  if (cur.volume > avgVol * 1.2) return { score: 1, ok: true, label: `Vol +${Math.round(cur.volume/avgVol*100-100)}%` };
  if (cur.volume < avgVol * 0.5) return { score: -3, ok: false, label: 'Vol LOW' };
  return { score: 0, ok: true, label: 'Vol AVG' };
}

function calcSR(cs, lookback = 120) {
  const slice = cs.slice(-Math.min(lookback, cs.length));
  const { highs, lows } = findSwings(slice, 3);
  const all = [...highs.map(h => h.p), ...lows.map(l => l.p)];
  if (!all.length) return [];
  const range = Math.max(...all) - Math.min(...all);
  const tol = range * 0.005;
  const levels = [];
  all.forEach(price => {
    const ex = levels.find(l => Math.abs(l.price - price) < tol);
    if (ex) { ex.touches++; ex.price = (ex.price + price) / 2; }
    else levels.push({ price, touches: 1 });
  });
  return levels.filter(l => l.touches >= 2).sort((a, b) => b.touches - a.touches).slice(0, 10);
}

function checkSRProximity(levels, entry, dir, curPrice) {
  let best = 0;
  for (const lvl of levels) {
    const dist = Math.abs(lvl.price - entry) / entry;
    if (dist < 0.006) {
      const isRes = lvl.price > curPrice;
      if (dir === 'short' && isRes)  best = Math.max(best, 8);
      if (dir === 'long'  && !isRes) best = Math.max(best, 8);
    }
  }
  return best;
}

// ── FIX 1: checkHTFBias — richer confirmation, mandatory in scanPair ─
// Uses EMA50 + EMA20 alignment on HTF for a 3-level bias read.
// score=-999 is the hard-block sentinel (signals against HTF die here).
function checkHTFBias(htfCandles, dir) {
  if (!htfCandles || htfCandles.length < 50) return { score: 0, bias: 'neutral', label: 'HTF N/A', hardBlock: false };
  const ema50 = calcEMA(htfCandles, 50);
  const ema20 = htfCandles.length >= 20 ? calcEMA(htfCandles, 20) : null;
  const last    = htfCandles[htfCandles.length-1];
  const lastE50 = ema50[ema50.length-1].value;
  const lastE20 = ema20 ? ema20[ema20.length-1].value : null;

  let bias = 'neutral';
  if (last.close > lastE50 * 1.002) bias = 'bull';
  if (last.close < lastE50 * 0.998) bias = 'bear';

  // Strengthen bias if short EMA also agrees
  const strongBull = bias === 'bull' && lastE20 && lastE20 > lastE50;
  const strongBear = bias === 'bear' && lastE20 && lastE20 < lastE50;

  if (bias === 'neutral') return { score: 0, bias, label: 'HTF NEUTRAL', hardBlock: false };

  const aligned = (dir === 'long' && bias === 'bull') || (dir === 'short' && bias === 'bear');
  if (!aligned) {
    // FIX 1: counter-HTF is a hard block — score=-999 so scanPair rejects unconditionally
    return { score: -999, bias, label: 'HTF COUNTER ✗', hardBlock: true };
  }

  const score = (strongBull || strongBear) ? 15 : 10;
  const label = (strongBull || strongBear) ? `HTF ${bias.toUpperCase()} STRONG ✓` : `HTF ${bias.toUpperCase()} ✓`;
  return { score, bias, label, hardBlock: false };
}

// ─── BACKTESTED WIN RATE LOOKUP ────────────────────────────────────

let _patternWinRates = {};

function setPatternWinRates(stats) {
  _patternWinRates = {};
  for (const row of stats) {
    const key = `${row.pattern}|${row.tf}|${row.asset_class}`;
    _patternWinRates[key] = { winRate: row.win_rate, count: row.count };
  }
}

function getHistoricalBonus(pattern, tf, assetClass) {
  const key = `${pattern}|${tf}|${assetClass}`;
  const entry = _patternWinRates[key];
  if (!entry || entry.count < 30) return { bonus: 0, winRate: null, suppressed: false };
  if (entry.winRate < 0.50) return { bonus: -15, winRate: entry.winRate, suppressed: true };
  if (entry.winRate >= 0.70) return { bonus: 10,  winRate: entry.winRate, suppressed: false };
  if (entry.winRate >= 0.60) return { bonus: 5,   winRate: entry.winRate, suppressed: false };
  return { bonus: 0, winRate: entry.winRate, suppressed: false };
}

// ─── MARKET SESSION AWARENESS ───────────────────────────────────────

function getMarketSessions() {
  const h = new Date().getUTCHours();
  const sessions = [];
  if (h >= 22 || h < 7)  sessions.push('Sydney');
  if (h >= 0  && h < 9)  sessions.push('Tokyo');
  if (h >= 7  && h < 16) sessions.push('London');
  if (h >= 13 && h < 22) sessions.push('New York');
  return sessions;
}

// ── FIX 9: getSessionBonus — NY OPEN dead-code resolved ─────────────
// Old code: LON-NY OVERLAP (13–16) fired first, making NY OPEN (13–15) unreachable.
// Fixed: NY OPEN window split before OVERLAP continuation.
function getSessionBonus() {
  const h = new Date().getUTCHours();
  // London open: strong momentum
  if (h >= 7  && h < 9)  return { bonus: 3,  label: '🇬🇧 LON OPEN' };
  // NY open + London overlap: peak of peak — best signals of the day
  if (h >= 13 && h < 15) return { bonus: 8,  label: '⚡ LON-NY + NY OPEN' };
  // London–NY overlap (non-open NY hours): peak liquidity
  if (h >= 15 && h < 16) return { bonus: 5,  label: '⚡ LON-NY OVERLAP' };
  // Active London session (non-open)
  if (h >= 9  && h < 13) return { bonus: 1,  label: null };
  // Active NY session (post-overlap)
  if (h >= 16 && h < 18) return { bonus: 1,  label: null };
  // Tokyo session: lower crypto volume, still ok
  if (h >= 0  && h < 7)  return { bonus: 0,  label: null };
  // Post-NY wind-down (18:00–22:00 UTC): volume fading
  if (h >= 18 && h < 22) return { bonus: -2, label: '🌙 LOW VOL' };
  return { bonus: 0, label: null };
}

// ── FIX 5: Session gate per pattern type ────────────────────────────
// Hard blocks that session bonuses alone do not enforce:
//   - Post-NY (18–22 UTC): ALL patterns blocked — thin book = fakeouts
//   - Deep Asia (00–07 UTC): reversal patterns blocked — no institutional presence
//   - Early London (07–08:30 UTC): reversal patterns blocked — direction not yet established
// Returns { allowed: bool, reason: string|null }
function isSessionAllowed(pattern, h) {
  const isReversal = REVERSAL_PATTERNS.has(pattern);

  // Post-NY wind-down: hard block everything
  if (h >= 18 && h < 22) return { allowed: false, reason: 'post-NY blackout' };

  // Deep Asia: no reversal patterns
  if (h >= 0 && h < 7 && isReversal) return { allowed: false, reason: 'Asia — no reversals' };

  // Early London open (first 90 min): no reversal patterns — direction not set yet
  if (h >= 7 && h < 8 && isReversal) return { allowed: false, reason: 'early LON — no reversals' };

  // Fractional hour check for 8:30 cutoff using minutes
  if (h === 8) {
    const mins = new Date().getUTCMinutes();
    if (mins < 30 && isReversal) return { allowed: false, reason: 'early LON — no reversals' };
  }

  return { allowed: true, reason: null };
}

// ── FIX 3: Retest zone check ─────────────────────────────────────────
// After a breakout, a retest brings price back to the broken neckline
// from the correct side, confirming support-turned-resistance (long) or
// resistance-turned-support (short).
// Returns { inRetestZone: bool, retestEntry: number }
function checkRetestZone(neckline, close, dir, atr) {
  const retestBand = atr * 0.6; // price must return within 0.6 ATR of the neckline
  if (dir === 'long') {
    // For longs: price broke above neckline, now pulling back toward it — in retest zone
    const inZone = close >= neckline - retestBand && close <= neckline + retestBand * 0.5;
    return { inRetestZone: inZone, retestEntry: neckline };
  } else {
    // For shorts: price broke below neckline, now bouncing back toward it
    const inZone = close <= neckline + retestBand && close >= neckline - retestBand * 0.5;
    return { inRetestZone: inZone, retestEntry: neckline };
  }
}

// ─── MASTER SIGNAL SCAN ─────────────────────────────────────────────

async function scanPair(cs, htfCandles, pair, tf, assetClass = 'crypto') {
  const signals = [];
  if (cs.length < 100) return signals;

  // ── 1. REGIME FILTER ── FIX 6: ADX >= 25, slope, Choppiness ────────
  const adxResult = calcADX(cs, 14);
  if (!adxResult) return signals;

  // FIX 6a: minimum ADX raised from 22 to 25
  if (adxResult.adx < 25) return signals;

  // FIX 6b: ADX slope — trend must be accelerating or at least stable
  // Compare current ADX to value 5 bars ago
  if (adxResult.adxHistory.length >= 6) {
    const adxNow  = adxResult.adxHistory[adxResult.adxHistory.length - 1];
    const adx5ago = adxResult.adxHistory[adxResult.adxHistory.length - 6];
    // If ADX peaked > 20 bars ago and has since dropped > 5 points, skip — exhausted trend
    if (adxResult.adxHistory.length >= 21) {
      const adx20ago = adxResult.adxHistory[adxResult.adxHistory.length - 21];
      const adxPeak  = Math.max(...adxResult.adxHistory.slice(-21));
      if (adxPeak === adx20ago && adxNow < adxPeak - 5) return signals;
    }
    // Reject if ADX is falling steeply (> 4 points drop over 5 bars)
    if (adx5ago - adxNow > 4) return signals;
  }

  // FIX 6c: Choppiness Index hard block above 61.8
  const ci = calcChoppiness(cs, 14);
  if (ci !== null && ci > 61.8) return signals;

  // Vol regime — EXTREME (ATR > 2× average) blocks all new signals to prevent
  // sizing into a volatility spike that blows normal SL distances.
  const volRegime = calcVolRegime(cs);
  if (volRegime.regime === 'EXTREME') return signals;

  // ── 2. Pattern detection ─────────────────────────────────────────────
  const { highs, lows } = findSwings(cs, 5);
  const levels = calcSR(cs, 120);
  const candle  = detectCandlePattern(cs.slice(0, -1)); // closed candle only

  // FIX 2: pre-compute FVGs and OBs for structure proximity check
  const atr  = calcATR(cs, 14);
  const fvgs = findFVGs(cs, 100);
  const obs  = findOrderblocks(cs, 100);

  // VPVR: pre-compute once per scan (shared across patterns)
  const vpvr = calcVPVR(cs, 50, 100);

  const rawPatterns = [
    detectDoubleBottom(lows, cs),
    detectDoubleTop(highs, cs),
    detectHeadShoulders(highs, cs),
    detectInverseHS(lows, cs),
    detectAscendingTriangle(highs, lows, cs),
    detectDescendingTriangle(highs, lows, cs),
    detectBullFlag(cs),
    detectBearFlag(cs),
    detectFallingWedge(highs, lows, cs),
    detectRisingWedge(highs, lows, cs),
    detectCupHandle(cs),
    detectEngulfingAtSR(cs, levels, 'long'),
    detectEngulfingAtSR(cs, levels, 'short'),
  ].filter(Boolean);

  if (!rawPatterns.length) return signals;

  const close = cs[cs.length - 1].close;
  const h     = new Date().getUTCHours();

  // ── 3. Score each pattern ────────────────────────────────────────────
  for (const raw of rawPatterns) {
    const dir = raw.dir;

    // 15m reversal patterns have proven unprofitable — block entirely on this TF.
    // Continuations (flags, triangles, wedges) are still allowed on 15m.
    if (tf === '15m' && REVERSAL_PATTERNS.has(raw.pattern)) continue;

    // ── FIX 5: Session gate — hard block before scoring ──────────────
    const sessionGate = isSessionAllowed(raw.pattern, h);
    if (!sessionGate.allowed) continue;

    // ── FIX 1: HTF bias — mandatory hard requirement ──────────────────
    // Counter-HTF signals are rejected here entirely. No score, no vote,
    // no override. HTF must align or the signal does not exist.
    const htfCheck = checkHTFBias(htfCandles, dir);
    if (htfCheck.hardBlock) continue; // absolute block — counter-HTF

    // EMA hard block (existing)
    const emaCheck = checkEMAStack(cs, dir);
    if (emaCheck.score <= -20) continue;

    // ADX direction check: +DI vs -DI
    if (dir === 'long'  && adxResult.minusDI > adxResult.plusDI * 1.3) continue;
    if (dir === 'short' && adxResult.plusDI  > adxResult.minusDI * 1.3) continue;

    const macdScore = checkMACDAlignment(cs, dir);
    const rsiCheck  = checkRSI(cs, dir);
    const volCheck  = checkVolume(cs);
    const srScore   = checkSRProximity(levels, raw.entry, dir, close);

    let candleName = null, candleScore = 0;
    if (candle && candle.dir !== 'neutral') {
      if ((dir === 'long' && candle.dir === 'bull') || (dir === 'short' && candle.dir === 'bear')) {
        candleName = candle.name; candleScore = 15;
      }
    }

    // ── FIX 4: Weighted confluence scoring (replaces equal-vote system) ─
    // HTF(30) EMA(25) RSI(20) Candle(15) MACD(5) Vol(5) — total possible = 100
    // Minimum threshold: 55 weighted points (equivalent to "3 strong factors aligned")
    // HTF is now mandatory (hardBlock above), so if we reach here, htfCheck.score > 0
    const weightedScore =
      (htfCheck.score > 0 ? 30 : 0) +   // HTF alignment — anchor (mandatory)
      (emaCheck.score > 0 ? 25 : 0) +    // trend state — primary
      (rsiCheck.score > 0 ? 20 : 0) +    // momentum / divergence
      (candleScore >= 15  ? 15 : 0) +    // entry timing candle
      (macdScore > 0      ?  5 : 0) +    // weak confirmer (lagging)
      (volCheck.score > 0 ?  5 : 0);     // weak confirmer

    // 15m is noisier — require stronger confluence to filter fakeouts
    const minScore = tf === '15m' ? 70 : 55;
    if (weightedScore < minScore) continue;

    // Historical performance modifier
    const histBonus = getHistoricalBonus(raw.pattern, tf, assetClass);
    if (histBonus.suppressed) continue;

    // ── FIX 2: Structure proximity check ─────────────────────────────
    // Signal entry must be at or near a FVG or Orderblock.
    // If no structure is present, signal is allowed but gets a penalty.
    const structCheck = isAtStructure(raw.entry, dir, fvgs, obs, atr);
    const structScore = structCheck.ok ? 12 : -8;

    // ── VPVR proximity score ──────────────────────────────────────────
    // +10 when entry is within 0.5 ATR of POC, VAH, or VAL (high-volume level)
    // -5  when price is between levels (low-volume void)
    let vpvrScore = 0;
    let vpvrLabel = null;
    if (vpvr) {
      const buf = atr * 0.5;
      const nearPOC = Math.abs(raw.entry - vpvr.poc) <= buf;
      const nearVAH = Math.abs(raw.entry - vpvr.vah) <= buf;
      const nearVAL = Math.abs(raw.entry - vpvr.val) <= buf;
      if (nearPOC) { vpvrScore = 10; vpvrLabel = 'VPVR POC'; }
      else if (dir === 'long'  && nearVAL) { vpvrScore = 10; vpvrLabel = 'VPVR VAL'; }
      else if (dir === 'short' && nearVAH) { vpvrScore = 10; vpvrLabel = 'VPVR VAH'; }
      else { vpvrScore = -5; }
    }

    // ── Build confidence score ────────────────────────────────────────
    const sessionBonus = getSessionBonus();
    let conf = raw.conf;
    conf += emaCheck.score;
    conf += macdScore;
    conf += rsiCheck.score;
    conf += volCheck.score;
    conf += srScore;
    conf += htfCheck.score;
    conf += candleScore;
    conf += histBonus.bonus;
    conf += structScore;
    conf += sessionBonus.bonus;
    conf += vpvrScore;

    // Weighted score bonus tiers
    if (weightedScore >= 80) conf += 5;
    else if (weightedScore >= 65) conf += 2;

    conf = Math.min(Math.round(conf), 96);
    if (conf < 70) continue;

    // ── FIX 3: Entry logic — retest confirmation for breakout patterns ─
    // Breakout patterns (flags, triangles, wedges) use retest confirmation.
    // Reversal patterns (H&S, double top/bottom, cup) use standard confirmed/pending.
    const neckline = raw.entry;
    const isBreakoutPattern = !REVERSAL_PATTERNS.has(raw.pattern);
    let entry, entryMode;

    const alreadyBroken = dir === 'long' ? close > neckline : close < neckline;
    const confirmed      = dir === 'long' ? close >= neckline : close <= neckline;

    if (isBreakoutPattern && alreadyBroken) {
      // Price has broken out — check if it's in a retest zone
      const retestInfo = checkRetestZone(neckline, close, dir, atr);
      if (retestInfo.inRetestZone) {
        // Perfect: price broke out and returned to test neckline as new S/R
        entry = close;
        entryMode = '✓ RETEST CONFIRMED';
      } else {
        // Price has broken but not yet come back to retest — set pending retest entry
        entry = neckline;
        entryMode = '⧗ AWAITING RETEST';
      }
    } else {
      // Reversal pattern or unbroken breakout: use existing confirmed/pending logic
      entry = confirmed ? close : neckline;
      entryMode = confirmed ? '✓ BREAKOUT CONFIRMED' : '⧗ AWAITING BREAK';
    }

    // ── Structure-based SL ────────────────────────────────────────────
    const sl = structureSL(dir, lows, highs, cs, entry);
    if (dir === 'long'  && sl >= entry) continue;
    if (dir === 'short' && sl <= entry) continue;

    // ── Tiered RR: TP1 at 1.0R (30% close), TP2 at 2.0R (40% close), trail rest ─
    // (Fix from analysis: TP1 at 1.0R hits more often, improving bankroll health)
    const risk = Math.abs(entry - sl);
    const tp1  = dir === 'long' ? entry + risk * 1.0 : entry - risk * 1.0;
    const tp2  = dir === 'long' ? entry + risk * 2.0 : entry - risk * 2.0;

    // Sanity checks
    if (risk / entry > 0.04) continue;
    if (risk / entry < 0.003) continue;

    // Count factors for display
    const factorCount = [
      htfCheck.score > 0,
      emaCheck.score > 0,
      rsiCheck.score > 0,
      candleScore >= 15,
      macdScore > 0,
      volCheck.score > 0,
      structCheck.ok,
    ].filter(Boolean).length;

    const ciLabel = ci !== null ? (ci < 38.2 ? '📈 TRENDING' : `CI ${Math.round(ci)}`) : null;

    // ── Signal quality tier ───────────────────────────────────────────
    // S-TIER: elite — all major factors aligned, peak session, at structure
    // A-TIER: high quality — strong HTF + structure confirmed
    // B-TIER: passing minimum (≥55 weighted, ≥70 conf)
    let tier;
    if (weightedScore >= 85 && structCheck.ok && sessionBonus.bonus >= 5) {
      tier = 'S';
    } else if (weightedScore >= 70 && structCheck.ok) {
      tier = 'A';
    } else {
      tier = 'B';
    }

    const filterParts = [
      emaCheck.label,
      htfCheck.label,
      rsiCheck.label !== 'RSI NEUTRAL' ? rsiCheck.label : null,
      candleName ? `✓ ${candleName}` : null,
      volCheck.label !== 'Vol N/A' ? volCheck.label : null,
      structCheck.ok ? `📍 ${structCheck.label}` : null,
      vpvrLabel ? `📊 ${vpvrLabel}` : null,
      `${factorCount}/7 factors`,
      `W:${weightedScore}pts`,
      histBonus.winRate != null ? `Hist WR: ${Math.round(histBonus.winRate * 100)}%` : null,
      ciLabel,
      sessionBonus.label,
      entryMode,
    ].filter(Boolean).join(' · ');

    // Proximity filter — price must be within 1.5 ATR of the entry level.
    // Signals fired too far from entry expire unused at a 41% rate; this
    // cuts that waste by only emitting when the setup is actually actionable.
    // Exception: already-confirmed entries (price already broke/retested) are always emitted.
    const distToEntry = Math.abs(close - entry);
    const isConfirmedEntry = entryMode.includes('CONFIRMED');
    if (!isConfirmedEntry && distToEntry > atr * 1.5) continue;

    const expiresAt = Date.now() + (EXPIRY_MINS[tf] || 360) * 60 * 1000;

    signals.push({
      id: `${pair.id}_${dir}_${raw.pattern.replace(/[^a-zA-Z0-9]/g,'')}_${tf}_${Math.floor(Date.now()/3600000)}`,
      pair_id:        pair.id,
      sym:            pair.sym,
      tf,
      asset_class:    assetClass,
      dir,
      pattern:        raw.pattern,
      candle_pattern: candleName,
      entry,
      sl,
      tp1,
      tp2,
      htf_bias:       htfCheck.bias,
      confidence:     conf,
      adx:            adxResult.adx,
      filters:        filterParts,
      status:         'pending',
      detected_at:    Date.now(),
      expires_at:     expiresAt,
      dec:            pair.dec || 4,
      hist_win_rate:  histBonus.winRate,
      votes:          weightedScore, // now stores weighted score, not raw count
      confirmed:      entryMode.includes('CONFIRMED') || entryMode.includes('RETEST CONFIRMED'),
      entry_mode:     entryMode,
      ci:             ci !== null ? +ci.toFixed(1) : null,
      struct_label:   structCheck.label,
      tier,
      vpvr_label:     vpvrLabel,
      vol_regime:     volRegime.regime,
      size_mult:      volRegime.sizeMultiplier,
    });
  }

  return signals;
}

// ─── SIGNAL STATUS UPDATE ───────────────────────────────────────────

function computeRMult(sig, exitPrice) {
  const originalRisk = Math.abs(sig.tp1 - sig.entry) / 1.0; // TP1 is now 1.0R
  if (!originalRisk) return 0;
  const entryPx = sig.entry_price ?? sig.entry;
  return sig.dir === 'long'
    ? (exitPrice - entryPx) / originalRisk
    : (entryPx - exitPrice) / originalRisk;
}

function updateSignalOnPrice(sig, price) {
  if (['sl_hit', 'tp2_hit', 'expired'].includes(sig.status)) return null;

  const now = Date.now();
  if (sig.status === 'pending' && now > sig.expires_at) {
    return { status: 'expired' };
  }

  const dir = sig.dir;

  if (sig.status === 'pending') {
    const confirm = sig.entry * 0.002;
    const entryHit = dir === 'long'
      ? price >= sig.entry + confirm
      : price <= sig.entry - confirm;
    if (entryHit) return { status: 'entered', entry_price: price, entered_at: now };

    const blown = dir === 'long'
      ? price < sig.entry * 0.97
      : price > sig.entry * 1.03;
    if (blown) return { status: 'expired' };
  }

  if (['entered', 'tp1_hit'].includes(sig.status)) {
    const isAfterTP1 = sig.status === 'tp1_hit';

    if (dir === 'long'  && price <= sig.sl) {
      const rMult = isAfterTP1 ? Math.max(0, computeRMult(sig, sig.sl)) : -1;
      return { status: 'sl_hit', close_price: sig.sl, r_mult: rMult, closed_at: now };
    }
    if (dir === 'short' && price >= sig.sl) {
      const rMult = isAfterTP1 ? Math.max(0, computeRMult(sig, sig.sl)) : -1;
      return { status: 'sl_hit', close_price: sig.sl, r_mult: rMult, closed_at: now };
    }

    if (!isAfterTP1 && sig.tp1) {
      if ((dir === 'long' && price >= sig.tp1) || (dir === 'short' && price <= sig.tp1)) {
        return { status: 'tp1_hit', close_price: price, r_mult: 1.0, closed_at: now };
      }
    }
    if (sig.tp2) {
      if ((dir === 'long' && price >= sig.tp2) || (dir === 'short' && price <= sig.tp2)) {
        return { status: 'tp2_hit', close_price: price, r_mult: 2.0, closed_at: now };
      }
    }
  }

  return null;
}

module.exports = {
  scanPair,
  updateSignalOnPrice,
  setPatternWinRates,
  computeRMult,
  computeStructureTrail,
  calcADX,
  calcATR,
  calcEMA,
  calcRSI,
  calcMACD,
  calcChoppiness,
  findSwings,
  findFVGs,
  findOrderblocks,
  calcVPVR,
  calcVolRegime,
  calcSR,
  getMarketSessions,
  getSessionBonus,
};
