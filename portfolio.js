'use strict';
const db = require('./db');

// ─────────────────────────────────────────────────────────────────────────────
// PAPER TRADING ENGINE
// Simulates real trading using live signal entry/exit prices.
// No exchange API needed — outcomes are settled from the same price feed
// that drives the live signal engine.
//
// Position sizing scales with pattern win rate so high-confidence setups
// get more capital and low-confidence setups get less.
// ─────────────────────────────────────────────────────────────────────────────

const MIN_COUNT_FOR_SCALE = 10; // need ≥10 historical trades to trust the win rate

function riskMultiplier(winRate, count) {
  if (!winRate || count < MIN_COUNT_FOR_SCALE) return 1.0;
  if (winRate >= 0.75) return 2.0;
  if (winRate >= 0.65) return 1.5;
  if (winRate >= 0.55) return 1.0;
  return 0.5;
}

function portfolioPayload() {
  return {
    portfolio:  db.getPortfolio.get(),
    open:       db.getOpenPaperTrades.all(),
    trades:     db.getPaperTrades.all(),
  };
}

// Called when a signal transitions to 'entered' (price hits entry zone).
function openTrade(sig, entryPrice) {
  try {
    const p    = db.getPortfolio.get();
    const stat = db.getPatternWinRate.get(sig.pattern, sig.tf, sig.asset_class || 'crypto');
    const wr   = stat?.win_rate ?? null;
    const cnt  = stat?.count ?? 0;
    const mult = riskMultiplier(wr, cnt);
    const riskAmt = +((p.balance * p.risk_pct / 100) * mult).toFixed(4);

    db.insertPaperTrade.run({
      id:            `pt_${sig.id}`,
      signal_id:     sig.id,
      sym:           sig.sym,
      tf:            sig.tf,
      dir:           sig.dir,
      pattern:       sig.pattern ?? null,
      entry:         +entryPrice,
      sl:            sig.sl,
      tp1:           sig.tp1,
      tp2:           sig.tp2 ?? null,
      risk_amount:   riskAmt,
      win_rate:      wr != null ? +wr.toFixed(4) : null,
      status:        'open',
      balance_before: +p.balance.toFixed(4),
      opened_at:     Date.now(),
    });

    console.log(`[Portfolio] OPEN ${sig.dir.toUpperCase()} ${sig.sym} ${sig.tf} | risk $${riskAmt.toFixed(2)} | wr=${wr ? (wr*100).toFixed(0)+'%' : 'n/a'} | bal $${p.balance.toFixed(2)}`);
    return portfolioPayload();
  } catch (e) {
    console.warn('[Portfolio] openTrade:', e.message);
    return null;
  }
}

// Called when TP1 is hit — full position closed at +1R.
// Closing 100% here gives symmetric 1:1 R:R (win = risk_amount, loss = risk_amount).
function hitTP1(sigId) {
  try {
    const t = db.getPaperTrade.get(sigId);
    if (!t || t.status !== 'open') return null;

    const pnl    = +(t.risk_amount).toFixed(4); // full 1R banked
    const p      = db.getPortfolio.get();
    const newBal = +(p.balance + pnl).toFixed(4);
    const newPeak= Math.max(p.peak, newBal);

    // Close fully at TP1 — no split position trailing to TP2
    db.updatePaperTradeClose.run({
      signal_id: sigId, pnl_final: pnl, pnl_total: pnl,
      balance_after: newBal, outcome: 'tp1', closed_at: Date.now(),
    });
    db.updatePortfolio.run({
      balance: newBal, peak: newPeak,
      total_pnl:    +(p.total_pnl + pnl).toFixed(4),
      wins:         p.wins + 1,
      losses:       p.losses,
      be_trades:    p.be_trades,
      total_trades: p.total_trades + 1,
      updated_at:   Date.now(),
    });

    console.log(`[Portfolio] TP1  ${sigId} | +$${pnl.toFixed(2)} (1R full close) | bal $${newBal.toFixed(2)}`);
    return portfolioPayload();
  } catch (e) {
    console.warn('[Portfolio] hitTP1:', e.message);
    return null;
  }
}

// Called when a trade fully closes (tp2, sl, be).
// rMult is the R-multiple for the CLOSING leg (2.0 for tp2, -1 for sl, 0 for be).
function closeTrade(sigId, rMult, outcome) {
  try {
    const t = db.getPaperTrade.get(sigId);
    if (!t || t.status === 'closed') return null;

    let pnlFinal = 0;
    let isWin = false, isLoss = false, isBE = false;

    if (t.status === 'tp1') {
      // TP1 already banked. Now settling the remaining 50%.
      if (outcome === 'tp2') {
        pnlFinal = +((t.risk_amount * rMult * 0.5)).toFixed(4);
        isWin    = true;
      } else {
        // be — SL moved to TP1, remainder closes at entry of second leg = 0
        pnlFinal = 0;
        isBE     = true;
      }
    } else {
      // Direct close before TP1 was ever hit
      pnlFinal = +((t.risk_amount * rMult)).toFixed(4);
      if (rMult > 0) isWin  = true;
      else if (rMult < 0) isLoss = true;
      else isBE = true;
    }

    const pnlTotal = +((t.pnl_tp1 || 0) + pnlFinal).toFixed(4);
    const p        = db.getPortfolio.get();
    const newBal   = +(p.balance + pnlFinal).toFixed(4);
    const newPeak  = Math.max(p.peak, newBal);

    db.updatePaperTradeClose.run({
      signal_id: sigId, pnl_final: pnlFinal, pnl_total: pnlTotal,
      balance_after: newBal, outcome, closed_at: Date.now(),
    });
    db.updatePortfolio.run({
      balance: newBal, peak: newPeak,
      total_pnl:    +(p.total_pnl + pnlFinal).toFixed(4),
      wins:         p.wins      + (isWin  ? 1 : 0),
      losses:       p.losses    + (isLoss ? 1 : 0),
      be_trades:    p.be_trades + (isBE   ? 1 : 0),
      total_trades: p.total_trades + 1,
      updated_at:   Date.now(),
    });

    const sign = pnlTotal >= 0 ? '+' : '';
    console.log(`[Portfolio] CLOSE ${outcome.toUpperCase()} ${t.sym} | total ${sign}$${pnlTotal.toFixed(2)} | bal $${newBal.toFixed(2)}`);
    return portfolioPayload();
  } catch (e) {
    console.warn('[Portfolio] closeTrade:', e.message);
    return null;
  }
}

// Reset to a fresh starting balance (e.g. for testing).
function resetPortfolio(startingBalance = 100, riskPct = 1.0) {
  try {
    db.resetPortfolio.run({ starting: startingBalance, risk_pct: riskPct, updated_at: Date.now() });
    db.db.prepare(`UPDATE paper_trades SET status='closed' WHERE status IN ('open','tp1')`).run();
    console.log(`[Portfolio] Reset to $${startingBalance} | risk ${riskPct}%`);
    return portfolioPayload();
  } catch (e) {
    console.warn('[Portfolio] reset:', e.message);
    return null;
  }
}

module.exports = { openTrade, hitTP1, closeTrade, resetPortfolio, portfolioPayload };
