'use strict';
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════
// CONFIG — single source of truth for all constants and instruments.
// Both server.js and backtester.js import from here so nothing is
// defined in two places.
// ═══════════════════════════════════════════════════════════════════

const PORT       = process.env.PORT || 3000;
const HOST       = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const TWELVE_KEY = process.env.TWELVE_DATA_KEY || '';

// ── Input validation ─────────────────────────────────────────────
const VALID_SYMBOL   = /^[A-Z0-9]{2,20}(\/[A-Z]{2,6})?$/;
const VALID_INTERVAL = new Set(['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w']);
function sanitizeLimit(raw, def = 200, max = 500) {
  const n = parseInt(raw, 10);
  return isNaN(n) ? def : Math.min(Math.max(n, 1), max);
}

// ── Instruments ───────────────────────────────────────────────────
const CRYPTO_PAIRS = [
  { id: 'BTCUSDT',  sym: 'BTC',    dec: 2, minMove: 0.01       },
  { id: 'ETHUSDT',  sym: 'ETH',    dec: 2, minMove: 0.01       },
  { id: 'SOLUSDT',  sym: 'SOL',    dec: 3, minMove: 0.001      },
  { id: 'BNBUSDT',  sym: 'BNB',    dec: 2, minMove: 0.01       },
  { id: 'XRPUSDT',  sym: 'XRP',    dec: 4, minMove: 0.0001     },
  { id: 'ADAUSDT',  sym: 'ADA',    dec: 4, minMove: 0.0001     },
  { id: 'DOGEUSDT', sym: 'DOGE',   dec: 5, minMove: 0.00001    },
  { id: 'AVAXUSDT', sym: 'AVAX',   dec: 3, minMove: 0.001      },
  { id: 'TRXUSDT',  sym: 'TRX',    dec: 5, minMove: 0.00001    },
  { id: 'TONUSDT',  sym: 'TON',    dec: 4, minMove: 0.0001     },
  { id: 'HYPEUSDT', sym: 'HYPE',   dec: 3, minMove: 0.001      },
  { id: 'SUIUSDT',  sym: 'SUI',    dec: 4, minMove: 0.0001     },
  { id: 'LINKUSDT', sym: 'LINK',   dec: 3, minMove: 0.001      },
  { id: 'DOTUSDT',  sym: 'DOT',    dec: 3, minMove: 0.001      },
  { id: 'LTCUSDT',  sym: 'LTC',    dec: 2, minMove: 0.01       },
  { id: 'ONDOUSDT', sym: 'ONDO',   dec: 4, minMove: 0.0001     },
  { id: 'WIFUSDT',  sym: 'WIF',    dec: 4, minMove: 0.0001     },
  { id: 'SHIBUSDT', sym: 'SHIB',   dec: 8, minMove: 0.00000001 },
  { id: 'NEARUSDT', sym: 'NEAR',   dec: 3, minMove: 0.001      },
  { id: 'INJUSDT',  sym: 'INJ',    dec: 3, minMove: 0.001      },
  { id: 'OPUSDT',   sym: 'OP',     dec: 4, minMove: 0.0001     },
  { id: 'ARBUSDT',  sym: 'ARB',    dec: 4, minMove: 0.0001     },
  { id: 'JUPUSDT',  sym: 'JUP',    dec: 4, minMove: 0.0001     },
  { id: 'FTMUSDT',  sym: 'FTM',    dec: 4, minMove: 0.0001     },
  { id: 'ATOMUSDT', sym: 'ATOM',   dec: 3, minMove: 0.001      },
  { id: 'TIAUSDT',  sym: 'TIA',    dec: 3, minMove: 0.001      },
];

const FOREX_PAIRS = [
  { id: 'XAU/USD', sym: 'GOLD',   dec: 2 },
  { id: 'XAG/USD', sym: 'SILVER', dec: 3 },
];

// ── Timeframe maps ────────────────────────────────────────────────
const TIMEFRAMES   = ['15m', '1h', '4h', '1d'];
const MTF_MAP      = { '15m': '1h', '1h': '4h', '4h': '1d', '1d': '1d' };
const CANDLE_LIMIT = { '15m': 200, '1h': 200, '4h': 150, '1d': 100 };
const EXPIRY_MINS  = { '15m': 120, '1h': 360, '4h': 960, '1d': 4320 };

// ── Scanner behaviour ─────────────────────────────────────────────
const MAX_CORRELATED       = 2;   // max same-direction signals active simultaneously
const SCAN_BATCH_SIZE      = 3;   // concurrent pairs per full-scan batch
const FAST_SCAN_BATCH_SIZE = 6;   // concurrent pairs per 15m fast-scan batch
const BACKTEST_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between backtest runs

module.exports = {
  PORT, HOST, TWELVE_KEY,
  VALID_SYMBOL, VALID_INTERVAL, sanitizeLimit,
  CRYPTO_PAIRS, FOREX_PAIRS,
  TIMEFRAMES, MTF_MAP, CANDLE_LIMIT, EXPIRY_MINS,
  MAX_CORRELATED, SCAN_BATCH_SIZE, FAST_SCAN_BATCH_SIZE, BACKTEST_COOLDOWN_MS,
};
