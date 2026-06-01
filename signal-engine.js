'use strict';

// ═══════════════════════════════════════════════════════════════════
// APEX SIGNAL ENGINE v2
// Runs server-side. Returns validated, high-probability signals only.
// Target: 65–75% win rate on 1:1.5 RR
// ═══════════════════════════════════════════════════════════════════

// Signal expiry per timeframe (in minutes)
const EXPIRY_MINS = { '15m': 120, '1h': 360, '4h': 960, '1d': 4320 };

// MTF lookup: for each TF, which higher TF to confirm against
const MTF_MAP = { '15m': '1h', '1h': '4h', '4h': '1d', '1d': '1d' };

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
  let adx = dxArr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dxArr.length; i++) adx = (adx * (period - 1) + dxArr[i]) / period;
  const pdi = pDI / atr * 100, mdi = mDI / atr * 100;
  return { adx: Math.round(adx * 10) / 10, plusDI: pdi, minusDI: mdi };
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

// ─── STRUCTURE-BASED SL ──────────────────────────────────────────────
// Places SL at the actual swing point that invalidates the pattern,
// with ATR buffer. Never a formula on entry price.

function structureSL(dir, lows, highs, cs, entry) {
  const atr = calcATR(cs, 14);
  const buf = atr * 0.5; // half-ATR buffer beyond the swing point
  if (dir === 'long') {
    // SL below the nearest relevant swing low
    const candidates = lows.filter(l => l.p < entry).sort((a, b) => b.i - a.i);
    if (candidates.length > 0) {
      const swingLow = candidates[0].p;
      return Math.min(swingLow - buf, entry - atr * 1.2); // at least 1.2 ATR from entry
    }
    return entry - atr * 1.5;
  } else {
    const candidates = highs.filter(h => h.p > entry).sort((a, b) => b.i - a.i);
    if (candidates.length > 0) {
      const swingHigh = candidates[0].p;
      return Math.max(swingHigh + buf, entry + atr * 1.2);
    }
    return entry + atr * 1.5;
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
  // Pre-breakout: fire while price is approaching neckline (within 3%).
  // The overshoot filter in scanPair handles price being too far above.
  if (cur.close < neck * 0.97) return null;
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
  if (cur.close > neck * 1.03) return null; // too far above — breakdown not imminent
  return { pattern: 'Double Top', dir: 'short', entry: neck, swingHigh: Math.max(h1.p, h2.p), conf: 75 };
}

function detectHeadShoulders(highs, cs) {
  if (highs.length < 5) return null;
  const n = highs.length;
  const [ls, lh, h, rh, rs] = [highs[n-5], highs[n-4], highs[n-3], highs[n-2], highs[n-1]];
  if (h.p <= lh.p || h.p <= rh.p) return null;
  if (Math.abs(lh.p - rh.p) / lh.p > 0.03) return null;
  if (ls.p > lh.p * 0.97 || rs.p > rh.p * 0.97) return null;
  const neckL = cs.slice(lh.i, h.i).reduce((mn, c) => Math.min(mn, c.low), Infinity);
  const neckR = cs.slice(h.i, rh.i).reduce((mn, c) => Math.min(mn, c.low), Infinity);
  const neck = (neckL + neckR) / 2;
  const cur = cs[cs.length - 1];
  if (cur.close > neck * 1.03) return null; // too far above — breakdown not imminent
  return { pattern: 'Head & Shoulders', dir: 'short', entry: neck, swingHigh: h.p, conf: 82 };
}

function detectInverseHS(lows, cs) {
  if (lows.length < 5) return null;
  const n = lows.length;
  const [ls, lh, h, rh, rs] = [lows[n-5], lows[n-4], lows[n-3], lows[n-2], lows[n-1]];
  if (h.p >= lh.p || h.p >= rh.p) return null;
  if (Math.abs(lh.p - rh.p) / lh.p > 0.03) return null;
  const neckL = cs.slice(lh.i, h.i).reduce((mx, c) => Math.max(mx, c.high), -Infinity);
  const neckR = cs.slice(h.i, rh.i).reduce((mx, c) => Math.max(mx, c.high), -Infinity);
  const neck = (neckL + neckR) / 2;
  const cur = cs[cs.length - 1];
  if (cur.close < neck * 0.97) return null; // too far below — breakout not imminent
  return { pattern: 'Inv. Head & Shoulders', dir: 'long', entry: neck, swingLow: h.p, conf: 82 };
}

function detectAscendingTriangle(highs, lows, cs) {
  if (highs.length < 3 || lows.length < 3) return null;
  const rH = highs.slice(-3), rL = lows.slice(-3);
  if (!rH.every(h => Math.abs(h.p - rH[0].p) / rH[0].p < 0.007)) return null;
  if (!(rL[0].p < rL[1].p && rL[1].p < rL[2].p)) return null;
  const cur = cs[cs.length - 1];
  if (cur.close < rH[0].p * 0.97) return null; // too far below resistance — breakout not imminent
  return { pattern: 'Ascending Triangle', dir: 'long', entry: rH[0].p * 1.001, resist: rH[0].p, conf: 72 };
}

function detectDescendingTriangle(highs, lows, cs) {
  if (highs.length < 3 || lows.length < 3) return null;
  const rH = highs.slice(-3), rL = lows.slice(-3);
  if (!rL.every(l => Math.abs(l.p - rL[0].p) / rL[0].p < 0.007)) return null;
  if (!(rH[0].p > rH[1].p && rH[1].p > rH[2].p)) return null;
  const cur = cs[cs.length - 1];
  if (cur.close > rL[0].p * 1.03) return null; // too far above support — breakdown not imminent
  return { pattern: 'Descending Triangle', dir: 'short', entry: rL[0].p * 0.999, support: rL[0].p, conf: 72 };
}

function detectBullFlag(cs) {
  if (cs.length < 30) return null;
  const recent = cs.slice(-30), pole = recent.slice(0, 10), flag = recent.slice(10);
  const poleMove = (pole[pole.length-1].close - pole[0].open) / pole[0].open;
  if (poleMove < 0.05) return null; // need 5%+ pole
  const flagHigh = Math.max(...flag.map(c => c.high)), flagLow = Math.min(...flag.map(c => c.low));
  if ((flagHigh - flagLow) / flagLow > 0.03) return null; // flag must be tight
  if (flag[flag.length-1].close > flagLow + (flagHigh - flagLow) * 0.6) return null; // must be in lower half
  const cur = cs[cs.length-1];
  if (cur.close < flagHigh * 0.97) return null; // too far from breakout level
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
  if (cur.close > flagLow * 1.03) return null; // too far from breakdown level
  return { pattern: 'Bear Flag', dir: 'short', entry: flagLow * 0.999, flagHigh, conf: 70 };
}

// Falling Wedge (bullish): lower highs + lower lows converging, breakout up
function detectFallingWedge(highs, lows, cs) {
  if (highs.length < 3 || lows.length < 3) return null;
  const rH = highs.slice(-3), rL = lows.slice(-3);
  // Highs must be declining
  if (!(rH[0].p > rH[1].p && rH[1].p > rH[2].p)) return null;
  // Lows must be declining too (but less steeply = converging)
  if (!(rL[0].p > rL[1].p && rL[1].p > rL[2].p)) return null;
  // Slope of highs must be steeper than slope of lows (convergence)
  const highSlope = (rH[2].p - rH[0].p) / (rH[2].i - rH[0].i);
  const lowSlope  = (rL[2].p - rL[0].p) / (rL[2].i - rL[0].i);
  if (highSlope >= lowSlope) return null; // not converging
  const cur = cs[cs.length - 1];
  if (cur.close < rH[2].p * 0.97) return null; // too far below upper trendline
  return { pattern: 'Falling Wedge', dir: 'long', entry: rH[2].p * 1.001, swingLow: rL[2].p, conf: 74 };
}

// Rising Wedge (bearish): higher highs + higher lows converging, breakout down
function detectRisingWedge(highs, lows, cs) {
  if (highs.length < 3 || lows.length < 3) return null;
  const rH = highs.slice(-3), rL = lows.slice(-3);
  // Highs and lows both rising
  if (!(rH[0].p < rH[1].p && rH[1].p < rH[2].p)) return null;
  if (!(rL[0].p < rL[1].p && rL[1].p < rL[2].p)) return null;
  // Lows slope must be steeper than highs slope (converging)
  const highSlope = (rH[2].p - rH[0].p) / (rH[2].i - rH[0].i);
  const lowSlope  = (rL[2].p - rL[0].p) / (rL[2].i - rL[0].i);
  if (lowSlope <= highSlope) return null;
  const cur = cs[cs.length - 1];
  if (cur.close > rL[2].p * 1.03) return null; // too far above lower trendline
  return { pattern: 'Rising Wedge', dir: 'short', entry: rL[2].p * 0.999, swingHigh: rH[2].p, conf: 74 };
}

// Cup & Handle (bullish): rounded bottom + brief consolidation before breakout
function detectCupHandle(cs) {
  if (cs.length < 60) return null;
  const slice = cs.slice(-60);
  const half  = Math.floor(slice.length / 2);
  // Left half: find cup low (price goes down then up)
  const leftHalf  = slice.slice(0, half);
  const rightHalf = slice.slice(half);
  const cupLow    = Math.min(...leftHalf.map(c => c.low));
  const rimLeft   = Math.max(leftHalf[0].high, leftHalf[1].high);
  const rimRight  = Math.max(...rightHalf.slice(0, 5).map(c => c.high));
  // Rims must be at similar level (within 1.5%)
  if (Math.abs(rimLeft - rimRight) / rimLeft > 0.015) return null;
  // Cup depth: 10–35% pullback from rim
  const depth = (rimLeft - cupLow) / rimLeft;
  if (depth < 0.10 || depth > 0.35) return null;
  // Handle: last 10 bars should be a tight consolidation below rim
  const handleSlice = slice.slice(-10);
  const handleHigh  = Math.max(...handleSlice.map(c => c.high));
  const handleLow   = Math.min(...handleSlice.map(c => c.low));
  if ((handleHigh - handleLow) / handleLow > 0.06) return null; // handle too wide
  if (handleHigh > rimRight * 1.005) return null; // handle must be below rim
  const cur = cs[cs.length - 1];
  if (cur.close < rimRight * 0.97) return null; // too far below rim — breakout not imminent
  return { pattern: 'Cup & Handle', dir: 'long', entry: rimRight * 1.001, swingLow: cupLow, conf: 78 };
}

// Bullish/bearish engulfing on clean S/R level
function detectEngulfingAtSR(cs, levels, dir) {
  if (cs.length < 3) return null;
  const c = cs[cs.length-1], p = cs[cs.length-2];
  const bodyC = Math.abs(c.close - c.open), bodyP = Math.abs(p.close - p.open);
  if (bodyC < bodyP * 1.2) return null; // engulf must be bigger
  const bullEngulf = c.close > c.open && p.close < p.open && c.open <= p.close && c.close >= p.open;
  const bearEngulf = c.close < c.open && p.close > p.open && c.open >= p.close && c.close <= p.open;
  if (dir === 'long' && !bullEngulf) return null;
  if (dir === 'short' && !bearEngulf) return null;
  // Must be at an S/R level
  const price = dir === 'long' ? c.low : c.high;
  const nearLevel = levels.some(l => Math.abs(l.price - price) / price < 0.008);
  if (!nearLevel) return null;
  return { pattern: dir === 'long' ? 'Bull Engulfing at S/R' : 'Bear Engulfing at S/R', dir, entry: c.close, conf: 74 };
}

function detectCandlePattern(cs) {
  if (cs.length < 3) return null;
  const c = cs[cs.length-1], p = cs[cs.length-2];
  const body = Math.abs(c.close - c.open), range = c.high - c.low;
  if (range === 0) return null;
  const upWick = c.high - Math.max(c.open, c.close), dnWick = Math.min(c.open, c.close) - c.low;
  const bullC = c.close > c.open, bearC = c.close < c.open;
  const bodyP = Math.abs(p.close - p.open);
  if (body < range * 0.1) return { name: 'Doji', dir: 'neutral' };
  if (bullC && dnWick > body * 2 && upWick < body * 0.5) return { name: 'Hammer', dir: 'bull' };
  if (bearC && upWick > body * 2 && dnWick < body * 0.5) return { name: 'Shooting Star', dir: 'bear' };
  if (bullC && dnWick > range * 0.6 && body < range * 0.3) return { name: 'Pin Bar ▲', dir: 'bull' };
  if (bearC && upWick > range * 0.6 && body < range * 0.3) return { name: 'Pin Bar ▼', dir: 'bear' };
  if (bullC && bearC && c.open < p.close && c.close > p.open && body > bodyP * 1.1) return { name: 'Bull Engulfing', dir: 'bull' };
  if (bearC && bullC && c.open > p.close && c.close < p.open && body > bodyP * 1.1) return { name: 'Bear Engulfing', dir: 'bear' };
  return null;
}

// ─── CONFIRMATION CHECKS ────────────────────────────────────────────

function checkEMAStack(cs, dir) {
  if (cs.length < 200) {
    // Shorter stack check when < 200 bars
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
  // Divergence check over last 15 bars
  const priceSlice = cs.slice(-15), rsiSlice = rsiData.slice(-15);
  if (rsiSlice.length >= 8) {
    const pH1 = Math.max(...priceSlice.slice(0,8).map(c => c.high)), pH2 = Math.max(...priceSlice.slice(7).map(c => c.high));
    const pL1 = Math.min(...priceSlice.slice(0,8).map(c => c.low)),  pL2 = Math.min(...priceSlice.slice(7).map(c => c.low));
    const rH1 = Math.max(...rsiSlice.slice(0,8).map(r => r.value)), rH2 = rsiSlice.length > 7 ? Math.max(...rsiSlice.slice(7).map(r => r.value)) : rH1;
    const rL1 = Math.min(...rsiSlice.slice(0,8).map(r => r.value)), rL2 = rsiSlice.length > 7 ? Math.min(...rsiSlice.slice(7).map(r => r.value)) : rL1;
    if (dir === 'short' && pH2 > pH1 * 1.001 && rH2 < rH1 - 2) return { score: 12, label: 'RSI BEAR DIV' };
    if (dir === 'long'  && pL2 < pL1 * 0.999 && rL2 > rL1 + 2) return { score: 12, label: 'RSI BULL DIV' };
  }
  // Extreme RSI values
  if (dir === 'long'  && last < 35) return { score: 5,  label: 'RSI OVERSOLD' };
  if (dir === 'short' && last > 65) return { score: 5,  label: 'RSI OVERBOUGHT' };
  if (dir === 'long'  && last > 70) return { score: -8, label: 'RSI TOO HIGH' };
  if (dir === 'short' && last < 30) return { score: -8, label: 'RSI TOO LOW' };
  return { score: 0, label: 'RSI NEUTRAL' };
}

function checkVolume(cs, dir) {
  if (cs.length < 26) return { score: 0, ok: false };
  const avgVol = cs.slice(-25,-1).reduce((s,c) => s+c.volume, 0) / 24;
  const cur = cs[cs.length-1];
  if (cur.volume > avgVol * 1.5) return { score: 3, ok: true, label: `Vol +${Math.round(cur.volume/avgVol*100-100)}%` };
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

function checkHTFBias(htfCandles, dir) {
  if (!htfCandles || htfCandles.length < 50) return { score: 0, bias: 'neutral', label: 'HTF N/A' };
  const ema50 = calcEMA(htfCandles, 50);
  const last = htfCandles[htfCandles.length-1], lastEma = ema50[ema50.length-1].value;
  let bias = 'neutral';
  if (last.close > lastEma * 1.002) bias = 'bull';
  if (last.close < lastEma * 0.998) bias = 'bear';
  if (bias === 'neutral') return { score: 0, bias, label: 'HTF NEUTRAL' };
  const aligned = (dir === 'long' && bias === 'bull') || (dir === 'short' && bias === 'bear');
  return { score: aligned ? 10 : -12, bias, label: aligned ? `HTF ${bias.toUpperCase()} ✓` : 'HTF COUNTER ✗' };
}

// ─── BACKTESTED WIN RATE LOOKUP ────────────────────────────────────
// Returns a confidence modifier based on pattern's historical performance.
// Loaded from DB at engine startup and refreshed after each backtest run.

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
  // Suppress patterns with < 50% historical win rate from auto-signals
  if (entry.winRate < 0.50) return { bonus: -15, winRate: entry.winRate, suppressed: true };
  if (entry.winRate >= 0.70) return { bonus: 10,  winRate: entry.winRate, suppressed: false };
  if (entry.winRate >= 0.60) return { bonus: 5,   winRate: entry.winRate, suppressed: false };
  return { bonus: 0, winRate: entry.winRate, suppressed: false };
}

// ─── MARKET SESSION AWARENESS ───────────────────────────────────────
// Crypto trades 24/7 but institutional volume clusters around FX sessions.
// Signals fired during high-liquidity windows have higher follow-through.
//
// All times UTC:
//   Sydney    22:00 – 07:00
//   Tokyo     00:00 – 09:00
//   London    07:00 – 16:00
//   New York  13:00 – 22:00
//
// Overlaps (best moments):
//   London–NY  13:00 – 16:00  ← highest crypto volume globally
//   Tokyo–Lon  07:00 – 09:00  ← moderate
//
// Dead zones (lowest volume, most fakeouts):
//   Post-NY / pre-Sydney  22:00 – 00:00
//   Deep Asia             02:00 – 07:00

function getMarketSessions() {
  const h = new Date().getUTCHours();
  const sessions = [];
  if (h >= 22 || h < 7)  sessions.push('Sydney');
  if (h >= 0  && h < 9)  sessions.push('Tokyo');
  if (h >= 7  && h < 16) sessions.push('London');
  if (h >= 13 && h < 22) sessions.push('New York');
  return sessions;
}

function getSessionBonus() {
  const h = new Date().getUTCHours();
  // London–NY overlap: peak liquidity → strongest signals
  if (h >= 13 && h < 16) return { bonus: 5,  label: '⚡ LON-NY OVERLAP' };
  // London open: strong momentum
  if (h >= 7  && h < 9)  return { bonus: 3,  label: '🇬🇧 LON OPEN' };
  // NY open: high volatility breakouts
  if (h >= 13 && h < 15) return { bonus: 3,  label: '🗽 NY OPEN' };
  // Active London session (non-open)
  if (h >= 9  && h < 13) return { bonus: 1,  label: null };
  // Active NY session (post-open)
  if (h >= 15 && h < 18) return { bonus: 1,  label: null };
  // Tokyo session: lower crypto volume, still ok
  if (h >= 0  && h < 7)  return { bonus: 0,  label: null };
  // Post-NY wind-down (18:00–22:00 UTC): volume fading
  if (h >= 18 && h < 22) return { bonus: -2, label: '🌙 LOW VOL' };
  return { bonus: 0, label: null };
}

// ─── MASTER SIGNAL SCAN ─────────────────────────────────────────────

async function scanPair(cs, htfCandles, pair, tf, assetClass = 'crypto') {
  const signals = [];
  if (cs.length < 100) return signals;

  // ── 1. REGIME FILTER — only trade trending markets ──────────────
  const adxResult = calcADX(cs, 14);
  if (!adxResult || adxResult.adx < 22) return signals; // skip ranging/choppy market

  // ── 2. Pattern detection (completed patterns only) ───────────────
  const { highs, lows } = findSwings(cs, 5);
  const levels = calcSR(cs, 120);
  const candle = detectCandlePattern(cs.slice(0, -1)); // use closed candle

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

  // ── 3. Score each pattern ────────────────────────────────────────
  for (const raw of rawPatterns) {
    const dir = raw.dir;

    // EMA hard block
    const emaCheck = checkEMAStack(cs, dir);
    if (emaCheck.score <= -20) continue;

    // HTF filter
    const htfCheck = checkHTFBias(htfCandles, dir);
    if (htfCheck.score <= -12) continue; // hard block on counter-HTF

    // ADX direction check: +DI vs -DI
    if (dir === 'long'  && adxResult.minusDI > adxResult.plusDI * 1.3) continue;
    if (dir === 'short' && adxResult.plusDI  > adxResult.minusDI * 1.3) continue;

    const macdScore  = checkMACDAlignment(cs, dir);
    const rsiCheck   = checkRSI(cs, dir);
    const volCheck   = checkVolume(cs, dir);
    const srScore    = checkSRProximity(levels, raw.entry, dir, cs[cs.length-1].close);

    let candleName = null, candleScore = 0;
    if (candle && candle.dir !== 'neutral') {
      if ((dir === 'long' && candle.dir === 'bull') || (dir === 'short' && candle.dir === 'bear')) {
        candleName = candle.name; candleScore = 10;
      }
    }

    // Confluence vote system — require 3 out of 5
    const votes = [
      candleScore >= 10,
      emaCheck.score > 0,
      macdScore > 0,
      htfCheck.score > 0,
      rsiCheck.score > 0 || volCheck.score > 0,
    ];
    const positiveVotes = votes.filter(Boolean).length;
    if (positiveVotes < 3) continue;

    // Historical performance modifier
    const histBonus = getHistoricalBonus(raw.pattern, tf, assetClass);
    if (histBonus.suppressed) continue; // pattern has poor historical win rate

    // Build confidence score
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
    conf += sessionBonus.bonus;           // session liquidity modifier
    if (positiveVotes === 5) conf += 5;
    else if (positiveVotes === 4) conf += 2;
    conf = Math.min(Math.round(conf), 96);
    if (conf < 70) continue;

    // ── Structure-based SL ──────────────────────────────────────
    const sl = structureSL(dir, lows, highs, cs, raw.entry);
    if (dir === 'long'  && sl >= raw.entry) continue; // degenerate
    if (dir === 'short' && sl <= raw.entry) continue;

    // ── Conservative 1:1.5 RR ──────────────────────────────────
    const risk = Math.abs(raw.entry - sl);
    const tp1  = dir === 'long' ? raw.entry + risk * 1.5 : raw.entry - risk * 1.5;
    const tp2  = dir === 'long' ? raw.entry + risk * 2.5 : raw.entry - risk * 2.5;

    // Sanity: risk must not be more than 4% of entry (too wide SL = bad signal)
    if (risk / raw.entry > 0.04) continue;
    // Sanity: risk must be at least 0.3% (too tight SL gets hunted)
    if (risk / raw.entry < 0.003) continue;

    // ── Stale-entry filter ──────────────────────────────────────────
    // If the current close has already run more than 1R past the entry,
    // a limit order at `entry` will never fill — the breakout has escaped.
    // Example: NEAR entry 2.36, risk 0.05, close 2.62 → 5.2R past entry → skip.
    const currentClose = cs[cs.length - 1].close;
    const overshootR = dir === 'long'
      ? (currentClose - raw.entry) / risk
      : (raw.entry - currentClose) / risk;
    if (overshootR > 1.0) continue; // price already 1R+ beyond entry — unenterable

    const filterParts = [
      emaCheck.label,
      htfCheck.label,
      rsiCheck.label !== 'RSI NEUTRAL' ? rsiCheck.label : null,
      candleName ? `✓ ${candleName}` : null,
      volCheck.label,
      `${positiveVotes}/5 factors`,
      histBonus.winRate != null ? `Hist WR: ${Math.round(histBonus.winRate * 100)}%` : null,
      sessionBonus.label,               // e.g. "⚡ LON-NY OVERLAP"
    ].filter(Boolean).join(' · ');

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
      entry:          raw.entry,
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
      // Extra info for frontend display
      hist_win_rate:  histBonus.winRate,
      votes:          positiveVotes,
    });
  }

  return signals;
}

// ─── SIGNAL STATUS UPDATE ───────────────────────────────────────────
// Called on each new price tick. Returns updated status if changed.

// Computes R-multiple for the trailing portion relative to original risk.
// Used after TP1 to calculate how much the trailing half made.
function computeRMult(sig, exitPrice) {
  const originalRisk = Math.abs(sig.tp1 - sig.entry) / 1.5;
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
    // Breakout entry with 0.5% confirmation buffer.
    // Price must CLEAR the neckline by 0.5%, not just touch it.
    // This filters out wick fakeouts — a real breakout sustains 0.5%+
    // past the level; a fake spike usually doesn't hold that far.
    const confirm = sig.entry * 0.005; // 0.5% past neckline
    const entryHit = dir === 'long'
      ? price >= sig.entry + confirm   // cleared neckline by 0.5% to the upside
      : price <= sig.entry - confirm;  // cleared neckline by 0.5% to the downside
    if (entryHit) return { status: 'entered', entry_price: price, entered_at: now };

    // Pattern invalidated — price moved away from neckline in the wrong direction
    const blown = dir === 'long'
      ? price < sig.entry * 0.97    // dropped 3% below neckline — setup failed
      : price > sig.entry * 1.03;   // rose 3% above neckline — setup failed
    if (blown) return { status: 'expired' };
  }

  if (['entered', 'tp1_hit'].includes(sig.status)) {
    const isAfterTP1 = sig.status === 'tp1_hit';

    // After TP1, sig.sl is the live trail stop (updated by server on each price tick).
    // For entered signals sig.sl is the original structure SL.
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
        return { status: 'tp1_hit', close_price: price, r_mult: 1.5, closed_at: now };
      }
    }
    if (sig.tp2) {
      if ((dir === 'long' && price >= sig.tp2) || (dir === 'short' && price <= sig.tp2)) {
        return { status: 'tp2_hit', close_price: price, r_mult: 2.5, closed_at: now };
      }
    }
  }

  return null;
}

module.exports = { scanPair, updateSignalOnPrice, setPatternWinRates, computeRMult, calcADX, calcATR, calcEMA, calcRSI, calcMACD, findSwings, calcSR, getMarketSessions, getSessionBonus };
