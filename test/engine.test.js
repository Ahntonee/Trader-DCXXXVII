'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const engine = require('../signal-engine');

test('session bonus follows the injected clock, not the wall clock', () => {
  assert.strictEqual(engine.getSessionBonus(Date.UTC(2026, 0, 5, 14, 0)).bonus, 8);   // LON-NY + NY open
  assert.strictEqual(engine.getSessionBonus(Date.UTC(2026, 0, 5, 19, 0)).bonus, -2);  // post-NY
  assert.strictEqual(engine.getSessionBonus(Date.UTC(2026, 0, 5, 3, 0)).bonus, 0);    // Asia
});

test('scanPair returns nothing for too little data and accepts a clock', async () => {
  const out = await engine.scanPair([], [], { id: 'BTCUSDT', sym: 'BTC', dec: 2 }, '1h', 'crypto', Date.UTC(2026, 0, 5, 14));
  assert.deepStrictEqual(out, []);
});

const base = { dir: 'long', entry: 100, sl: 98, tp1: 102, tp2: 104, status: 'pending', expires_at: Date.now() + 1e6 };
test('long lifecycle: pending → entered → tp1_hit', () => {
  assert.strictEqual(engine.updateSignalOnPrice(base, 99), null);
  assert.strictEqual(engine.updateSignalOnPrice(base, 100.5).status, 'entered');
  const entered = { ...base, status: 'entered', entry_price: 100.5 };
  assert.strictEqual(engine.updateSignalOnPrice(entered, 97.9).status, 'sl_hit');
  assert.strictEqual(engine.updateSignalOnPrice(entered, 102.1).status, 'tp1_hit');
});
test('pending signal expires when price blows through entry', () => {
  assert.strictEqual(engine.updateSignalOnPrice(base, 96).status, 'expired');
});
