'use strict';
require('dotenv').config();
const fetch = require('node-fetch');

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE = `https://api.telegram.org/bot${TOKEN}`;

async function sendMessage(text, attempt = 0) {
  if (!TOKEN || !CHAT_ID || TOKEN === 'your_telegram_bot_token_here') return;
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
      timeout: 10_000,
    });
    if (res.status === 429 && attempt < 2) {           // Telegram flood control
      const j = await res.json().catch(() => ({}));
      const wait = Math.min((j.parameters?.retry_after || 2), 30) * 1000;
      await new Promise(r => setTimeout(r, wait));
      return sendMessage(text, attempt + 1);
    }
    if (!res.ok) console.warn(`[Telegram] Send failed: HTTP ${res.status}`);
  } catch (e) {
    console.warn('[Telegram] Send failed:', e.message);
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      return sendMessage(text, attempt + 1);
    }
  }
}

function formatSignal(sig) {
  const dir = sig.dir === 'long' ? '🟢 LONG' : '🔴 SHORT';
  const arrow = sig.dir === 'long' ? '▲' : '▼';
  const rrRisk = ((Math.abs(sig.entry - sig.sl) / sig.entry) * 100).toFixed(2);
  const rrTp1  = ((Math.abs(sig.tp1  - sig.entry) / sig.entry) * 100).toFixed(2);
  const rrTp2  = sig.tp2 ? ((Math.abs(sig.tp2 - sig.entry) / sig.entry) * 100).toFixed(2) : null;

  return [
    `<b>${arrow} APEX SIGNAL — ${dir}</b>`,
    `<b>${sig.sym}  [${sig.tf.toUpperCase()}]</b>`,
    ``,
    `📍 <b>ENTRY:</b>  ${sig.entry.toFixed(sig.dec || 4)}`,
    `🛑 <b>STOP:</b>   ${sig.sl.toFixed(sig.dec || 4)}  (–${rrRisk}%)`,
    `✅ <b>TP1:</b>    ${sig.tp1.toFixed(sig.dec || 4)}  (+${rrTp1}%)  → close full position (+1R)`,
    rrTp2 ? `🎯 <b>TP2:</b>    ${sig.tp2.toFixed(sig.dec || 4)}  (+${rrTp2}%)  → optional runner target` : '',
    ``,
    `📊 Pattern: ${sig.pattern}${sig.candle_pattern ? ' · ' + sig.candle_pattern : ''}`,
    `🔎 Filters: ${sig.filters || '—'}`,
    `📈 Regime:  ADX ${sig.adx ? sig.adx.toFixed(1) : '—'} · HTF ${(sig.htf_bias || 'neutral').toUpperCase()}`,
    `💡 Confidence: <b>${sig.confidence}%</b>`,
    ``,
    `⏰ Valid for: ${sig.tf === '15m' ? '2h' : sig.tf === '1h' ? '6h' : sig.tf === '4h' ? '16h' : '3 days'}`,
    `📌 Copy entry/SL/TP to <b>any exchange</b>`,
  ].filter(l => l !== null && l !== undefined).join('\n');
}

function formatTPHit(sig, level) {
  const emoji = level === 'tp1' ? '✅' : '🎯';
  const note = level === 'tp1'
    ? 'Position closed at +1R. Optional runner: stop moves to TP1.'
    : 'Runner reached TP2 (trade was already closed at +1R).';
  return `${emoji} <b>TP${level === 'tp1' ? '1' : '2'} HIT</b> — ${sig.sym} [${sig.tf}]\nPattern: ${sig.pattern}\n${note}`;
}

function formatSLHit(sig) {
  return `🛑 <b>STOPPED</b> — ${sig.sym} [${sig.tf}]\nPattern: ${sig.pattern}\nSL: ${sig.sl}`;
}

module.exports = { sendMessage, formatSignal, formatTPHit, formatSLHit };
