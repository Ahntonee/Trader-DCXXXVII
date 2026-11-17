'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { requireAdmin, originAllowed, rateLimit } = require('../security');

function mockRes() {
  return { code: 200, body: null, headers: {},
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; } };
}
function run(mw, req) { const res = mockRes(); let nexted = false; mw(req, res, () => { nexted = true; }); return { res, nexted }; }

beforeEach(() => { delete process.env.ADMIN_TOKEN; delete process.env.NODE_ENV; delete process.env.ALLOWED_ORIGINS; });

test('production without ADMIN_TOKEN fails closed (503)', () => {
  process.env.NODE_ENV = 'production';
  const { res, nexted } = run(requireAdmin, { headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  assert.strictEqual(nexted, false); assert.strictEqual(res.code, 503);
});
test('dev without token: loopback allowed, remote forbidden', () => {
  assert.strictEqual(run(requireAdmin, { headers: {}, socket: { remoteAddress: '::1' } }).nexted, true);
  const r = run(requireAdmin, { headers: {}, socket: { remoteAddress: '8.8.8.8' } });
  assert.strictEqual(r.nexted, false); assert.strictEqual(r.res.code, 403);
});
test('token set: missing/wrong → 401, correct → next', () => {
  process.env.ADMIN_TOKEN = 's3cret-token';
  const req = h => ({ headers: h, socket: { remoteAddress: '8.8.8.8' } });
  assert.strictEqual(run(requireAdmin, req({})).res.code, 401);
  assert.strictEqual(run(requireAdmin, req({ authorization: 'Bearer nope' })).res.code, 401);
  assert.strictEqual(run(requireAdmin, req({ authorization: 's3cret-token' })).res.code, 401);
  assert.strictEqual(run(requireAdmin, req({ authorization: 'Bearer s3cret-token' })).nexted, true);
});
test('websocket origin: same host ok, foreign blocked, allow-list honoured', () => {
  assert.strictEqual(originAllowed(undefined, 'app.com'), true);
  assert.strictEqual(originAllowed('https://app.com', 'app.com'), true);
  assert.strictEqual(originAllowed('https://evil.com', 'app.com'), false);
  assert.strictEqual(originAllowed('not a url', 'app.com'), false);
  process.env.ALLOWED_ORIGINS = 'https://partner.io, https://x.io';
  assert.strictEqual(originAllowed('https://partner.io', 'app.com'), true);
});
test('rate limiter returns 429 after max', () => {
  const lim = rateLimit({ windowMs: 60_000, max: 3 });
  const req = { ip: '1.2.3.4' };
  for (let i = 0; i < 3; i++) assert.strictEqual(run(lim, req).nexted, true);
  const r = run(lim, req);
  assert.strictEqual(r.nexted, false); assert.strictEqual(r.res.code, 429);
  assert.ok(r.res.headers['Retry-After']);
});
