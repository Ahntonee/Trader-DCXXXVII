'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// DB location is configurable so it can live on a PERSISTENT disk.
// Default: alongside the app (fine for local / a VPS where the disk
// persists). On an ephemeral host (Render free tier) point DB_PATH at a
// mounted persistent disk, e.g. DB_PATH=/var/data/apex.db, so journal
// history survives restarts and redeploys.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'apex.db');
try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch {}
console.log(`[DB] Using database at: ${DB_PATH}`);

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    pair_id TEXT NOT NULL,
    sym TEXT NOT NULL,
    tf TEXT NOT NULL,
    asset_class TEXT DEFAULT 'crypto',
    dir TEXT NOT NULL,
    pattern TEXT NOT NULL,
    candle_pattern TEXT,
    entry REAL NOT NULL,
    sl REAL NOT NULL,
    tp1 REAL NOT NULL,
    tp2 REAL,
    htf_bias TEXT,
    confidence INTEGER NOT NULL,
    adx REAL,
    filters TEXT,
    status TEXT DEFAULT 'pending',
    entry_price REAL,
    close_price REAL,
    r_mult REAL,
    detected_at INTEGER NOT NULL,
    entered_at INTEGER,
    closed_at INTEGER,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id TEXT NOT NULL,
    sym TEXT NOT NULL,
    tf TEXT NOT NULL,
    dir TEXT NOT NULL,
    pattern TEXT NOT NULL,
    htf_bias TEXT,
    entry REAL,
    exit_price REAL,
    sl REAL,
    tp1 REAL,
    tp2 REAL,
    outcome TEXT NOT NULL,
    r_mult REAL NOT NULL,
    pnl_pct REAL,
    confidence INTEGER,
    opened_at INTEGER,
    closed_at INTEGER,
    date TEXT
  );

  CREATE TABLE IF NOT EXISTS pattern_stats (
    pattern TEXT NOT NULL,
    tf TEXT NOT NULL,
    asset_class TEXT NOT NULL,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    total_r REAL DEFAULT 0,
    count INTEGER DEFAULT 0,
    win_rate REAL DEFAULT 0,
    avg_r REAL DEFAULT 0,
    PRIMARY KEY (pattern, tf, asset_class)
  );

  CREATE TABLE IF NOT EXISTS backtest_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    tf TEXT NOT NULL,
    pattern TEXT NOT NULL,
    total_signals INTEGER,
    wins INTEGER,
    losses INTEGER,
    win_rate REAL,
    avg_r REAL,
    max_dd REAL,
    sharpe REAL,
    sample_from TEXT,
    sample_to TEXT
  );
`);

// ── Signals ──────────────────────────────────────────────────
const insertSignal = db.prepare(`
  INSERT OR IGNORE INTO signals
  (id,pair_id,sym,tf,asset_class,dir,pattern,candle_pattern,entry,sl,tp1,tp2,htf_bias,confidence,adx,filters,status,detected_at,expires_at)
  VALUES (@id,@pair_id,@sym,@tf,@asset_class,@dir,@pattern,@candle_pattern,@entry,@sl,@tp1,@tp2,@htf_bias,@confidence,@adx,@filters,@status,@detected_at,@expires_at)
`);

const updateSignalStatus = db.prepare(`
  UPDATE signals SET status=@status, entry_price=@entry_price, close_price=@close_price,
  r_mult=@r_mult, entered_at=@entered_at, closed_at=@closed_at WHERE id=@id
`);

const getActiveSignals = db.prepare(`
  SELECT * FROM signals WHERE status NOT IN ('sl_hit','tp2_hit','expired') ORDER BY detected_at DESC
`);

const getSignalById = db.prepare(`SELECT * FROM signals WHERE id=?`);

const expireOldSignals = db.prepare(`
  UPDATE signals SET status='expired' WHERE status='pending' AND expires_at < ? AND status NOT IN ('entered','sl_hit','tp2_hit','expired')
`);

// ── Journal ───────────────────────────────────────────────────
const insertJournal = db.prepare(`
  INSERT INTO journal (signal_id,sym,tf,dir,pattern,htf_bias,entry,exit_price,sl,tp1,tp2,outcome,r_mult,pnl_pct,confidence,opened_at,closed_at,date)
  VALUES (@signal_id,@sym,@tf,@dir,@pattern,@htf_bias,@entry,@exit_price,@sl,@tp1,@tp2,@outcome,@r_mult,@pnl_pct,@confidence,@opened_at,@closed_at,@date)
`);

const getJournal   = db.prepare(`SELECT * FROM journal ORDER BY closed_at DESC LIMIT 200`);
const clearJournal = db.prepare(`DELETE FROM journal`);
const updateSignalSL = db.prepare(`UPDATE signals SET sl=@sl WHERE id=@id`);

// ── Pattern stats ─────────────────────────────────────────────
const upsertPatternStat = db.prepare(`
  INSERT INTO pattern_stats (pattern,tf,asset_class,wins,losses,total_r,count,win_rate,avg_r)
  VALUES (@pattern,@tf,@asset_class,@wins,@losses,@total_r,@count,@win_rate,@avg_r)
  ON CONFLICT(pattern,tf,asset_class) DO UPDATE SET
    wins=wins+@wins, losses=losses+@losses, total_r=total_r+@total_r, count=count+@count,
    win_rate=CAST(wins+@wins AS REAL)/CAST(count+@count AS REAL),
    avg_r=(total_r+@total_r)/CAST(count+@count AS REAL)
`);

const getPatternStats = db.prepare(`SELECT * FROM pattern_stats ORDER BY count DESC`);

const getPatternWinRate = db.prepare(`
  SELECT win_rate, count FROM pattern_stats WHERE pattern=? AND tf=? AND asset_class=?
`);

// ── Backtest results ──────────────────────────────────────────
const insertBacktestResult = db.prepare(`
  INSERT INTO backtest_results (run_at,symbol,tf,pattern,total_signals,wins,losses,win_rate,avg_r,max_dd,sharpe,sample_from,sample_to)
  VALUES (@run_at,@symbol,@tf,@pattern,@total_signals,@wins,@losses,@win_rate,@avg_r,@max_dd,@sharpe,@sample_from,@sample_to)
`);

const getBacktestResults = db.prepare(`
  SELECT * FROM backtest_results WHERE run_at=(SELECT MAX(run_at) FROM backtest_results) ORDER BY win_rate DESC
`);

const getSignalSummary = db.prepare(`
  SELECT
    COUNT(*)                                                              AS total_fired,
    SUM(CASE WHEN status='tp1_hit' THEN 1 ELSE 0 END)                    AS tp1_hits,
    SUM(CASE WHEN status='tp2_hit' THEN 1 ELSE 0 END)                    AS tp2_hits,
    SUM(CASE WHEN status='sl_hit'  THEN 1 ELSE 0 END)                    AS sl_hits,
    SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END)                    AS expired,
    SUM(CASE WHEN status IN ('pending','entered') THEN 1 ELSE 0 END)           AS active
  FROM signals
`);

// Today-scoped counts (detected since the given UTC-midnight ms timestamp).
// Used by the journal TODAY view for fired/expired, which the client
// can't derive on its own (expired signals never reach the journal).
const getTodaySummary = db.prepare(`
  SELECT
    SUM(CASE WHEN detected_at >= @todayStart THEN 1 ELSE 0 END)                          AS fired_today,
    SUM(CASE WHEN status='expired' AND detected_at >= @todayStart THEN 1 ELSE 0 END)     AS expired_today
  FROM signals
`);

module.exports = {
  insertSignal,
  updateSignalStatus,
  getActiveSignals,
  getSignalById,
  expireOldSignals,
  insertJournal,
  getJournal,
  clearJournal,
  updateSignalSL,
  upsertPatternStat,
  getPatternStats,
  getPatternWinRate,
  insertBacktestResult,
  getBacktestResults,
  getSignalSummary,
  getTodaySummary,
  db,
};
