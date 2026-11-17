'use strict';
// Isolated DB so tests never touch real data. Must be set before requiring db.js.
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apex-test-')), 'test.db');
process.env.DB_PATH = tmp;

const { test, after } = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const portfolio = require('../portfolio');

after(() => { try { db.db.close(); fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch { } });

const sig = (id) => ({ id, sym: 'BTC', tf: '15m', dir: 'long', pattern: 'Double Top', asset_class: 'crypto', sl: 98, tp1: 102, tp2: 104 });
const bal = () => db.getPortfolio.get().balance;

test('TP1 closes the whole trade at exactly +1R (1:1 payout) and counts once', () => {
  portfolio.resetPortfolio(100, 1);
  portfolio.openTrade(sig('a'), 100);
  const risk = db.getPaperTrade.get('a').risk_amount;
  portfolio.hitTP1('a');
  assert.strictEqual(+bal().toFixed(4), +(100 + risk).toFixed(4));
  assert.strictEqual(db.getPortfolio.get().total_trades, 1);
  // A later runner event must not settle the closed trade again.
  assert.strictEqual(portfolio.closeTrade('a', 2.0, 'tp2'), null);
  assert.strictEqual(portfolio.hitTP1('a'), null);
  assert.strictEqual(db.getPortfolio.get().total_trades, 1);
});

test('stop loss loses exactly 1R', () => {
  portfolio.resetPortfolio(100, 1);
  portfolio.openTrade(sig('b'), 100);
  const risk = db.getPaperTrade.get('b').risk_amount;
  portfolio.closeTrade('b', -1, 'sl');
  assert.strictEqual(+bal().toFixed(4), +(100 - risk).toFixed(4));
  assert.strictEqual(db.getPortfolio.get().losses, 1);
});

test('withTransaction rolls back every write when one fails', () => {
  const before = db.getJournal.all().length;
  assert.throws(() => db.withTransaction(() => {
    db.insertJournal.run({ signal_id: 'x', sym: 'BTC', tf: '15m', dir: 'long', pattern: 'p', htf_bias: null,
      entry: 1, exit_price: 2, sl: 0, tp1: 2, tp2: 3, outcome: 'tp1', r_mult: 1, pnl_pct: 1,
      confidence: 80, opened_at: 1, closed_at: 2, date: '2026-01-01' });
    throw new Error('boom');
  }));
  assert.strictEqual(db.getJournal.all().length, before);
});
