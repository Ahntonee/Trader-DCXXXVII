# Trading Sessions & Their Characteristics

## New York Session — 13:00–22:00 UTC
**Best for:** Breakouts, momentum continuation, high-volume trend trades

- Highest USD volume of the day — institutional order flow dominates
- News-driven moves (NFP, CPI, FOMC) create clean breakout structures
- Best patterns: Bull/Bear Flag, Ascending/Descending Triangle, Channel Breakout
- Avoid: Counter-trend reversal setups in the first 2 hours (13:00–15:00 UTC) — spread is wide, fakeouts are common
- HTF bias confirmation is critical here — if the 4H is bearish, don't take long flags
- ADX tends to spike above 30 during NY — trend-following setups have the highest completion rate
- RR: TP2 (2.0R) is achievable most often during NY compared to any other session

---

## London Session — 07:00–16:00 UTC
**Best for:** Trend initiation, breakouts off Asia range, structure trades

- Second highest volume session — overlaps with NY 13:00–16:00 UTC (the "power hour")
- London often establishes the day's directional bias by 09:00–10:00 UTC
- Best patterns: Double Top/Bottom off the Asia range highs/lows, Bull/Bear Wedge breaks, FVG fills
- The London open (07:00–09:00 UTC) is the best time to catch fresh setups — price often sweeps Asian session liquidity before reversing
- Orderblocks from the Asian session become key targets — watch for FVG + Orderblock confluence at those levels
- MTF stack most reliable here — 15m/1h/4h often align during London trend days

---

## Asian Session — 00:00–09:00 UTC
**Best for:** Range trading, mean reversion, accumulation setups

- Low volume, tight range — typically 40–60% of the daily ATR consumed here
- Best patterns: Symmetrical Triangle, Wedge, Double Bottom/Top within a range
- NOT a breakout session — breakouts during Asia have a high failure rate (65%+)
- The Asia range high and low become the key liquidity targets for London/NY to sweep
- Best used for: identifying the range, marking the highs/lows, and waiting for London to break
- REVERSAL patterns (Double Top, Double Bottom, Head & Shoulders) have higher completion rates here than in London/NY because the market is ranging
- Low ADX environment (<20) is normal — confluence scoring will naturally be lower, so only S-TIER or A-TIER signals are worth acting on

---

## London–NY Overlap — 13:00–16:00 UTC
**Best for:** Highest probability setups of the entire trading day

- The only 3-hour window where both institutional desks (London and New York) are simultaneously active
- Volume spikes, spreads tighten, and directional conviction is at its peak
- Any continuation pattern that fires during this window with MTF stack confirmed = highest quality trade of the day
- If a signal fires here with S-TIER rating + MTF confluence + NY/London session bonus = maximum position size

---

## Dead Zone / Avoid — 18:00–22:00 UTC
**Why the engine blocks signals here:**

- Late NY session — London is closed, volume drops 60–70%
- Institutional desks are unwinding positions, not initiating
- Price action becomes choppy and random — "noise" rather than "signal"
- Breakouts during this window fail approximately 70% of the time
- The engine auto-expires all pending signals at 18:00 UTC and stops emitting new ones until the next London open

---

## Session–Pattern Matrix

| Pattern | Best Session | Worst Session | Notes |
|---------|-------------|---------------|-------|
| Bull/Bear Flag | NY, London | Asia | Needs volume to complete |
| Double Top/Bottom | Asia, London open | NY mid-session | Best as range boundary plays |
| Head & Shoulders | London, London–NY overlap | Asia | Needs break + retest confirmation |
| Ascending/Descending Triangle | London–NY overlap | Asia | Volume on breakout is key |
| Symmetrical Triangle | Asia, London open | Late NY | Low volatility resolution |
| Bull/Bear Wedge | London open | Late NY dead zone | Often traps breakout traders |
| FVG Fill | Any session | — | Time-insensitive; price seeks imbalance regardless |
| Orderblock Reaction | London open, NY open | Asia (slow reaction) | Best when fresh + session confluence |
| Channel Breakout | NY, London | Asia | Needs momentum to sustain |

---

## How the Engine Uses This

The engine assigns a **session bonus** to each signal:

```
NY session (13–18 UTC):           +5 pts to weighted score
London session (07–16 UTC):       +5 pts
London–NY overlap (13–16 UTC):    +10 pts (both bonuses stack)
Asian session (00–07 UTC):         0 pts (no bonus)
Dead zone (18–22 UTC):            signals blocked / auto-expired
```

A signal that fires at 14:30 UTC (London–NY overlap) gets +10 points added to its confluence score before tier assignment. This is why S-TIER signals cluster during the overlap window — the overlap bonus pushes borderline A-TIER setups over the 85-point S-TIER threshold.
