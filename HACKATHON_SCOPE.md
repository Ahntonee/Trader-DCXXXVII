# Apex Verified — Scope for the Concordium Trusted Agents Hackathon

Status: draft v1 · written 2026-11-17 · owner: TraderVI maintainer
Hackathon: Encode Club × Concordium, 2 Nov – 9 Dec 2026 (final submission **Wed 9 Dec, 23:59 UTC**, Checkpoint 1 **Sun 22 Nov, 23:59 UTC**).

> **Read this first — what "passing the grant" can and cannot mean.**
> No one can guarantee a grant. The hackathon pays 1M CCD to each of the top three projects; those winners then *remain eligible* for Concordium's 75M CCD Grants Program, which is a separate, application-based process. Concordium has **not published** (in anything I could find on 2026‑11‑17) a formal rulebook for that 75M program. Secondary sources describe it as: milestone-based tranches, aimed at registered companies, focused on identity, AI-agent accountability, payments and integrating existing apps, favouring real users and a clear plan to productise. This scope therefore (a) satisfies every *published* hackathon requirement and judging criterion, (b) follows every *published* Concordium technical/policy statement, and (c) pre-builds the evidence a grants committee asks for. Items that are **assumptions or unverified** are marked ⚠ and listed in §10 for confirmation at office hours.

---

## 1. The idea in one paragraph

Apex Terminal is a signal engine that watches 26 crypto pairs and publishes trade signals. Today it is an anonymous server with no identity and a self-reported track record. **Apex Verified** turns it into an *accountable agent*: it is registered in the Concordium Agent Registry (CIS‑8004) under a verified owner, carries an ERC‑8004‑format Agent Card with the *Verified by Concordium* badge, sells its signal feed to other agents/apps per request using **x402** (with sponsored transactions so buyers need no CCD for fees), gates regulated-looking features behind a zero-knowledge **age/jurisdiction proof** (Verify & Access), and writes a **tamper-evident decision log** whose hash is anchored on-chain. A counterparty agent can call the registry MCP server, see *who is accountable*, check the signal history is untampered, pay, and consume the feed.

Why this fits the brief ("take an agent you already run and make it accountable"): the agent exists and runs today; the hackathon work adds *prove a verified human stands behind it → pay/get paid → leave a record*, which is exactly the three verbs in the brief.

## 2. Published requirements → how we meet them

| Published requirement (Encode page) | Our deliverable | Evidence for submission |
|---|---|---|
| Runs on **Concordium testnet** | All on-chain pieces deployed to testnet | CCDExplorer links (agent token, anchor txs) |
| ≥1 Concordium component used *meaningfully* | We use five: Agent Registry + badge, x402, sponsored tx, Verify & Access, registry MCP server (PLTs for the payment token if available on testnet ⚠) | Demo + architecture diagram |
| Description of what/how/which components | `README` + this doc condensed | Repo + submission form |
| Public code repository | New public repo, OSI licence (Apache‑2.0 preferred — see §7) | GitHub URL |
| Demo video ≤ 3 min | Scripted end-to-end flow (§8) | Video |
| CCDExplorer link | Agent registration tx, anchor txs, payment txs | Links |
| **Path to production** write-up | §9 | `PRODUCTION_PATH.md` |

| Published judging criterion | Where we score |
|---|---|
| Depth of integration (identity, registry, payments) | Registry + badge + MCP lookup + x402 + sponsored tx + ZK gating all in one flow, not a bolt-on |
| Credible path to production | Real operating product with 4+ months of live history, security work already done (Part 1 fixes), mainnet plan with costs/KYB (§9) |
| It works (clear end-to-end demo) | One scripted happy path + one failure path (revoked agent / unpaid request) |
| Usefulness | Agents/humans that need machine-readable, verifiable signals; accountability for automated trading advice |

Note the stated judging stance: *"Test tokens are free, so judging is not about transaction counts."* Do not pad transactions; depth beats volume.

## 3. What Concordium has published that we must respect

Sourced from Concordium's own pages (full list in §11). These are *constraints on how we build and what we may claim*:

1. **The badge ≠ endorsement.** Concordium states the badge "does not mean Concordium has reviewed the agent's code, audited its behaviour, or approved its use case." → Our UI, README, Agent Card and marketing must never say "Concordium-approved/audited/endorsed". Use: "Accountable owner verified by Concordium ID."
2. **Registration prerequisites.** A verified Concordium ID (human *or* business) must exist *before* an agent is minted; registration needs identity verification, scope definition and the principal's consent. → The owner (you, or better your company) completes Concordium ID verification before Week 4.
3. **Registry mechanics (CIS‑8004).** Agent = CIS‑2 NFT; `agent_uri` → hosted Agent Card JSON; `metadata_hash` = SHA‑256 of those exact bytes; reserved metadata key `agentWallet` (needs proof of control: EIP‑712 for Ethereum wallets); transfer clears `agentWallet`; revoked agents stay queryable but inactive; ≤1 `external_reference`. → Agent Card must be served byte-stable (hash pinned); we must handle `revoke` and `transfer` states in the consumer.
4. **Cross-chain binding (CIS‑8).** External keys (EVM/Solana) bind to a Concordium account via a signed canonical message. Concordium notes CIS‑8 "proves which key is the agent, not who physically holds it." → We document key custody honestly (§6, risk R4).
5. **Privacy model.** Zero-knowledge proofs; no personal data on-chain; Concordium describes itself as "privacy with accountability built in", *not* anonymity — disclosure to authorities exists as a separate process (details not published ⚠). → We store **no personal data** on-chain or in our DB; we store only proof results/anchors.
6. **Verify & Access.** Verifier service checks the wallet's ZK proof; backend writes a *Verification Audit Anchor (VAA)* on-chain; UI via `@concordium/verification-web-ui`; chain SDKs `@concordium/web-sdk` (TS) / `concordium-rust-sdk`. → Use these packages (do not hand-roll proof verification).
7. **Agent stack.** x402 attaches verified identity to payments (pay → prove → access); Protocol-Level Locks hold value at protocol layer, custody stays with the human principal; MCP server `agent-registry-mcp.concordium.com` for machine-readable trust queries; A2A Agent Card for discovery. → Mirror these flows; do not invent a parallel trust mechanism.
8. **Registration cost.** Registration is described as free for Concordium-native wallets via sponsored transactions; each single-agent account needs a deploy-and-fund step. → Budget faucet CCD for it.
9. **Newness.** Concordium calls the registry newly launched; some layers are "still in development." → Expect rough edges; pin versions, and use office hours (§10).
10. **Regulatory framing Concordium uses.** "Agents are not legal persons, but their credential links them to one"; "Regulators require a legally accountable human behind every financial action"; the hackathon brief names **EU AI Act Article 12** record-keeping. → Our accountability module (§5, WP5) is designed against Article 12's *record-keeping* idea, voluntarily (see §6 for why it is not legally mandatory for us).

## 4. Non-goals (explicitly out of scope)

- No mainnet deployment, real-money flows, or custody of user funds during the hackathon.
- No claim of trading profitability or "guaranteed" win rates. (The legacy 85–90% win-rate comment in `signal-engine.js` header and inflated stored stats must not appear in any submission material.)
- No new trading strategies. The engine stays as is; the work is identity, payments, accountability.
- No Ethereum/Solana contract deployment of our own; we *bind* an existing EVM/Solana key via CIS‑8 only if it adds to the demo ⚠.

## 5. Work packages

Estimated 22 days from today. Effort in focused days. Order matters: WP0–1 unblock everything.

| # | Package | Output | Acceptance test | Days |
|---|---|---|---|---|
| **WP0** | **Foundation (done in this session)** | Auth on admin routes, WS origin check, rate limits, validated backtest/reset, single-count P&L, backtest clock/dedupe/cost fixes, Docker/Render persistence, 12 unit tests, CI | `npm test` green; smoke test returns 401/400/clean shutdown | ✔ |
| **WP1** | **Identity & registration** | Owner completes Concordium ID (testnet); wallet set up; agent minted in CIS‑8004 testnet; Agent Card JSON (ERC‑8004 format + `concordium` extension) served from `/.well-known/agent-card.json`; `metadata_hash` matches served bytes | Explorer shows agent token; `sha256(GET agent-card)` == on-chain hash; MCP lookup returns owner + verified status | 3 |
| **WP2** | **Signal API for agents + x402 paywall** | `GET /v1/signals` returns 402 with payment requirements; paid request (testnet) returns signed signal batch; price per call in config; sponsored-tx path so buyer needs no fee token | Scripted buyer agent pays on testnet and receives data; unpaid call gets 402; replayed payment rejected | 5 |
| **WP3** | **Counterparty trust check (consumer side)** | Small buyer-agent script/MCP client: before paying, queries registry MCP → requires `active`, not `revoked`, badge present, owner verified; refuses otherwise | Demo: revoke agent → buyer refuses; restore → buyer pays | 2 |
| **WP4** | **Verify & Access gate** | Premium endpoints (e.g., leverage-level suggestions, Telegram channel invite) require ZK proof of age ≥ 18 and non-restricted jurisdiction via Concordium verifier service + `verification-web-ui`; VAA anchored; **no PII stored** | Without proof → blocked; valid proof → access; DB/log inspection shows no personal data | 4 |
| **WP5** | **Accountability log (Art. 12‑style)** | Append-only, hash-chained event log (signal created, entry, TP1/SL, config/model version, operator actions incl. admin calls with actor); periodic Merkle root anchored on testnet; `/v1/audit/verify?from&to` recomputes the chain | Tamper with a row → verification fails; anchor tx visible on CCDExplorer; export CSV/JSON | 4 |
| **WP6** | **Compliance surface** | Disclaimers (not investment advice; badge ≠ endorsement), AI-use disclosure on signals, privacy notice, licence file, data-retention policy, third-party data attribution (KuCoin/CoinGecko/Binance terms check) | Checklist in §6 all ticked | 1.5 |
| **WP7** | **Hardening for demo/production claim** | Fix remaining items in §8 of Part‑1 follow-ups: structured logging, metrics endpoint, secrets rotation doc, dependency audit clean, backups of SQLite, uptime check | CI green incl. `npm audit`; restore-from-backup drill documented | 2 |
| **WP8** | **Submission pack** | Repo README, architecture diagram, 3‑min video, `PRODUCTION_PATH.md`, CCDExplorer links, Checkpoint 1 entry | Self-review against Encode checklist the day before | 2 |

### Progress log

| Date | Done |
|---|---|
| 2026-11-17 | Project created on Encode, team group created, Week 1 report sent. Project name registered/approved as **"Apex Trading Tool"**. |
| 2026-11-17 | **WP5 core built** ([audit.js](audit.js)): hash-chained append-only log with DB-level triggers, Merkle checkpoints, anchor verification; hooked into signal lifecycle + admin actions + boot (build/rule-set fingerprint); public `GET /v1/audit`, `/v1/audit/verify`, `/v1/audit/anchors[/:id/verify]`; admin `POST /v1/audit/checkpoint` and `/anchors/:id/tx`. 6 tests incl. tamper detection. |
| 2026-11-17 | **WP1 prep built**: [agent-card.json](agent-card.json) (ERC‑8004 + A2A v1.0 shape per Concordium's Agent Card page), served byte-exact at `/.well-known/agent-card.json`, `GET /v1/agent-card/hash` returns the SHA‑256 to pin on-chain. Apache‑2.0 `LICENSE` added. |
| **Blocked on owner** | Concordium ID verification, testnet wallet + faucet CCD, public hosting URL (card has `REPLACE-WITH-PUBLIC-HOST` placeholders), then `register` on CIS‑8004 testnet and add `concordium-badge` extension + `registrations` to the card (re-hash and `setAgentURI`). |

Buffer ≈ 2 days. If time slips, **cut order**: WP4 → WP7 extras → WP3 polish. Never cut WP1, WP2, WP5, WP8.

### Architecture (target)

```
Buyer agent ──► registry MCP (verify owner/badge/active) ──► Apex Verified API
      │                                                         │ 402 + x402 requirements
      └──── pay (testnet, sponsored tx) ───────────────────────►│
                                                                ├─ Signal engine (existing)
Human user ── Concordium ID wallet ── ZK proof ─► Verifier ────►│  (age/jurisdiction gate, VAA anchor)
                                                                ├─ Audit log (hash chain) ──► Merkle root anchored on-chain
                                                                └─ Agent Card (hash pinned in CIS‑8004 token)
```

## 6. Policy & regulatory compliance checklist

⚠ I am not a lawyer. Items marked "counsel" need a qualified opinion before mainnet/real users. The point for the hackathon is to *show we identified and designed for these*, which is part of a credible production path.

| Area | What applies (as best published) | What we do |
|---|---|---|
| **Concordium badge terms** | Badge is accountability, not endorsement; no published trademark/usage rules ⚠ | Use exact wording from §3.1; ask Concordium for badge display rules in office hours; keep a screenshot of the answer |
| **EU AI Act** | Art. 12 requires automatic event logging for **high-risk** AI systems. A crypto-signal engine is *probably not* high-risk (Annex III is credit scoring, employment, etc.) — counsel to confirm. Art. 50 transparency duties (telling people they interact with AI/AI-generated content) may apply. | Implement logging *voluntarily* (WP5) because the hackathon brief asks for it; label signals as automated; document why we think we're not high-risk |
| **Financial regulation** | Publishing trade signals can be "investment advice/recommendation" in some jurisdictions (EU MiFID II for financial instruments; MiCA covers advice on crypto-assets for authorised providers; UK/US have their own regimes). | Position as **informational / paper-trading research feed**, not personalised advice; no custody; no execution; jurisdiction gating (WP4); prominent disclaimers; **counsel** before charging real users |
| **GDPR / data protection** | Personal data minimisation; no personal data on a public ledger | Store no PII; only ZK proof results + anchors; privacy notice; Telegram chat IDs are personal data → document retention, allow deletion |
| **KYC/AML for payments** | Receiving payments may bring obligations depending on token/jurisdiction | Testnet only now; mainnet plan routes revenue through a registered entity (§9) |
| **Open-source licensing** | Old Concordium grants required all funded code open-sourced, no closed-source dependency, Apache‑2.0 preferred (GPLv3/MIT acceptable) — may not carry over to the 2026 program ⚠ | Apache‑2.0 for the whole repo from day one; all deps are MIT/ISC/BSD (verify with `license-checker` in CI) |
| **Third-party data terms** | KuCoin/Binance/CoinGecko API terms on redistribution | Do **not** resell raw market data; sell derived signals only; attribute sources; confirm terms (WP6) |
| **Hackathon rules** | Encode & Concordium T&Cs, Checkpoint 1, deadline | Read the T&Cs on sign-in; I could not read the FAQ answers; confirm originality/IP rules for a *pre-existing* project ⚠ |
| **Security** | Concordium cites a CertiK audit of the chain, not of third-party apps | Keep Part‑1 controls; add key-management doc; never commit `.env`/keys; testnet keys only |

## 7. Grant-readiness (what a committee will look for)

From the published program descriptions and the archived open-grants guidelines (use as a *proxy*, ⚠):

- **A registered legal entity** able to sign a grant agreement and pass **full KYC/KYB and due diligence** → incorporate or designate one *before* 9 Dec; the Agent Registry owner should be that business identity (Concordium ID supports businesses).
- **Milestone plan with deliverables and dates**, payable in tranches → draft in §9.
- **Real users / usage evidence** → keep the 4‑month live record; add a public status page and real pilot consumers (even 3 external agent/dev users with logged calls).
- **Technical soundness and code quality** → CI, tests, audit log, public commits; team GitHub profiles linked.
- **Open source, attribution, code of conduct, documentation/tutorial** → Apache‑2.0, `CONTRIBUTING`, `CODE_OF_CONDUCT`, written docs, short tutorial video.
- **Ongoing reporting** (weekly meetings were mandatory in the old program) → be ready to commit.
- **Announcement guidelines** → coordinate any public announcement of the grant with Concordium.
- **No unattributed third-party work** (old program: immediate termination) → keep a `NOTICE`/attribution file.

## 8. Demo script (≤ 3 min)

1. (0:00) Problem: anonymous signal bots; nobody accountable. Show Apex running live (existing UI).
2. (0:20) Explorer: Apex agent token on testnet; badge; owner verified; Agent Card hash matches.
3. (0:50) Buyer agent queries registry MCP → "active, verified owner" → calls API → 402 → pays on testnet (sponsored, no fee token) → receives signals.
4. (1:30) **Failure path:** owner revokes → buyer agent refuses to pay.
5. (1:50) Human unlocks premium feature with a ZK age proof; show DB has no personal data; VAA on explorer.
6. (2:15) Audit page: verify chain OK → tamper a row → verify FAILS → Merkle anchor on explorer.
7. (2:40) Path to production slide: entity, mainnet, counsel, milestones.

## 9. Path to production (draft for `PRODUCTION_PATH.md`)

| Phase | Window | Milestone | Exit criterion |
|---|---|---|---|
| M0 Hackathon | to 9 Dec 2026 | Testnet agent + x402 + audit log live | Submission accepted |
| M1 Hardening | Dec 2026 – Jan 2027 | Move SQLite → Postgres or replicated volume; secrets manager; monitoring/alerting; backups tested; pen-test of API | No critical findings |
| M2 Entity & legal | Jan – Feb 2027 | Company registered; KYB; counsel opinion on signals/advice and payments; ToS/privacy policy | Written opinion + signed ToS |
| M3 Mainnet pilot | Feb – Mar 2027 | Mainnet agent registration (owner = company), PLT/stablecoin pricing, 5–10 pilot consumers | ≥ 1,000 paid calls, uptime ≥ 99% |
| M4 Scale | Q2 2027 | Multi-region, SLA, more chains via CIS‑8 | Revenue covers infra |

Grant tranche mapping (proposal to make to Concordium): T1 on M2, T2 on M3, T3 on M4. ⚠ Amounts/structure are theirs to set.

## 10. Open questions to resolve (ask at Tue/Fri office hours or in Encode Discord)

1. Official eligibility and application route for the 75M CCD program for hackathon winners (entity required? KYB? licence? reporting?).
2. Badge display/trademark rules and revocation semantics.
3. Testnet contract addresses for CIS‑8004/CIS‑8 and the hosted MCP server; sponsored-transaction service access on testnet.
4. Is a **PLT stablecoin** available on testnet for x402 pricing? Otherwise price in test CCD.
5. Lawful-disclosure process (who may request owner identity, under what conditions) so we can describe it accurately.
6. Whether a pre-existing, previously-built project is eligible and what the originality/IP terms are.
7. Whether our trading-signal use case raises any concern for Concordium's brand/policy (financial advice optics).
8. Checkpoint 1 requirements (the FAQ answer wasn't visible to me).

## 11. Sources

- Encode Club programme page — https://www.encodeclub.com/programmes/concordium-trusted-agents-hackathon (dates, prizes, requirements, judging)
- Concordium — The Agent Registry, Explained — https://www.concordium.com/article/the-agent-registry-explained
- Concordium — Verified by Concordium badge — https://www.concordium.com/article/the-verified-by-concordium-badge-the-trust-mark-that-travels-with-your-agent
- Concordium — Agent Registry is live — https://www.concordium.com/article/the-concordium-agent-registry-is-live-the-accountability-layer-erc-8004-doesnt-have
- Concordium — Agent Identity & Trust — https://www.concordium.com/agent-identity-trust
- Concordium — AI agent technology — https://www.concordium.com/build/ai-agent-technology
- Concordium docs — Agent Registry / CIS‑8004 — https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/index.html
- Concordium docs — Verify & Access — https://docs.concordium.com/en/mainnet/tutorials/verify-access/index.html
- Concordium Free & Open Grants Program (archived, proxy only) — https://github.com/Concordium/Concordium-Free-Open-Grants-Program
- grants.watch update #46 (secondary report on the 75M program) — https://sovereignsignal.substack.com/p/grantswatch-weekly-update-46
