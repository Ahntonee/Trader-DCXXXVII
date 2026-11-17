'use strict';
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════
// SECURITY — admin auth, WebSocket origin check, rate limiting, headers.
// Dependency-free so it can be unit-tested without booting the server.
// ═══════════════════════════════════════════════════════════════════

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isProd() { return process.env.NODE_ENV === 'production'; }

// Constant-time comparison. Hashing first equalises lengths so
// timingSafeEqual never throws and length is not leaked.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Guards every state-changing / expensive endpoint.
//  - ADMIN_TOKEN set  → require `Authorization: Bearer <token>`.
//  - ADMIN_TOKEN unset, production → endpoints disabled (fail closed).
//  - ADMIN_TOKEN unset, development → loopback clients only.
function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    if (isProd()) {
      return res.status(503).json({ error: 'Admin endpoints disabled: ADMIN_TOKEN is not set' });
    }
    if (LOOPBACK.has(req.socket?.remoteAddress)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  }
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m || !safeEqual(m[1], token)) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

// Browsers always send Origin on WebSocket upgrades. Reject cross-site
// pages (cross-site WebSocket hijacking); allow same-host and any
// explicitly listed origin. Non-browser clients (no Origin) are allowed —
// they carry no ambient browser credentials to abuse.
function originAllowed(origin, hostHeader) {
  if (!origin) return true;
  if (allowedOrigins().includes(origin)) return true;
  try { return new URL(origin).host === hostHeader; } catch { return false; }
}

// Fixed-window per-IP limiter.
function rateLimit({ windowMs = 60_000, max = 120 } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  timer.unref();
  return function limiter(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(key, e); }
    if (++e.count > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (isProd()) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

module.exports = { requireAdmin, originAllowed, rateLimit, securityHeaders, safeEqual };
