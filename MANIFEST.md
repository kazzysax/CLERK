# MANIFEST — Clerk, ready to go live

This file is written so an AI assistant (or a new engineer) can read it once
and know exactly what every file is for and in what order to use them. Files
NOT listed here were earlier iterations and are intentionally excluded —
this package contains the current, superseding version of everything.

## 1. Smart contract (X Layer, chain 196 mainnet / 1952 testnet)
| File | Purpose |
|---|---|
| `contracts/ClerkLedgerV2.sol` | The production contract. Escrow, resolution lifecycle, reopen window, pull payments, pause circuit breaker, two-step operator rotation, dual guarded ratings, onchain Bayesian scoring. This is the ONLY contract version to deploy — there is no V1 in this package. |
| `contracts/ClerkLedgerV2.abi.json` | Compiled ABI. Consumed by `server.mjs`, `portal.html`, and `reputation.html`. |
| `test/ClerkLedgerV2.test.js` | 30-test Hardhat/EVM suite covering the full lifecycle, window boundaries, guardrails, pause asymmetry, rotation, and solvency. Run before any deploy. |
| `hardhat.config.cjs` | Real network config — `xlayerTestnet` (1952) and `xlayer` (196), reads `PRIVATE_KEY` from `.env`. |
| `hardhat.test.config.cjs` | Local test-run config (offline solc). Use only for running the test suite. |
| `scripts/deploy-v2.cjs` | Deploys ClerkLedgerV2. On testnet, also walks one full lifecycle (register → resolve → rate → finalize → claim) so real transactions land on the explorer immediately. |
| `package.json`, `package-lock.json` | Dependencies (Hardhat, ethers, solc, etc). Run `npm install` first. |

## 2. Backend service (Node/Express)
| File | Purpose |
|---|---|
| `server.mjs` | The production service. Signed webhooks, idempotent ticket handling, serialized tx queue, LLM guardrails (fail-safe to escalation), rate limiting, PII scrubbing, swap endpoints, admin kill switch, finalize sweep. This is the ONLY backend to run — supersedes any earlier demo backend. |
| `conversation.mjs` | Multi-turn thread handling: classifies customer replies (question/followup/thanks/complaint/other) and auto-reopens a resolution onchain if the customer says it didn't work. |
| `calibration.mjs` | Per-category auto-send thresholds, measured calibration (claimed confidence vs. real success rate), duplicate-ticket detection, escalation-note effectiveness. |
| `swap.mjs` | OKX DEX aggregator integration — lets a merchant swap any held token into OKB for gas/escrow. Merchant signs every tx; Clerk never custodies funds. |
| `xlayer.config.mjs` | Single source of truth for chain IDs, RPCs (with OKX failover), explorer URLs, DEX endpoints, token addresses. Imported everywhere so nothing hardcodes network values twice. |
| `conversation.test.mjs` | 13-test suite for the conversation router (mocked deps). Run with `node conversation.test.mjs`. |
| `.env.example` | Every required and optional environment variable, with generation notes. Copy to `.env` and fill before running `server.mjs`. |

## 3. Database (Supabase — run these SQL files in this exact order)
| Order | File | Adds |
|---|---|---|
| 1 | `supabase/schema.sql` | Core multi-tenant memory: merchants, documents, vector chunks, tone profiles, calibration state, tickets. Row-Level Security on every table. |
| 2 | `supabase/schema-production.sql` | Single-use rating tokens, reopen-rate ops view. |
| 3 | `supabase/schema-conversations.sql` | Per-ticket message threads, turn intent, thread-state columns. |
| 4 | `supabase/schema-calibration.sql` | Per-category calibration table, escalation-outcome tracking, pattern-detection function. |

## 4. Front-ends (static HTML, open directly or host anywhere)
| File | Purpose | Before use |
|---|---|---|
| `landing.html` | **Public marketing page.** The pitch, the live conversation mock, and the "under the hood" feature grid. Links to onboarding, the console, and the track record. | none required |
| `clerk-neo.html` | **Live onboarding + merchant dashboard.** Real wallet connect, a real `registerMerchant` transaction to fund escrow, and a dashboard that reads tickets, escrow, and reputation directly from the deployed contract — no simulated data. | Set `window.CLERK_CONTRACT`; serve over http (see below) |
| `portal.html` | **Real merchant console**, the ongoing-operations counterpart to onboarding — deposit/withdraw escrow, reopen resolutions, same live chain reads. | Same as above |
| `reputation.html` | **Public, no-login page.** Reads Clerk's track record live from the contract; links every resolution to the OKX explorer. This is the "verifiable, not claimed" proof artifact — link to it anywhere. | Same as above |
| `rate.html` | Customer one-tap rating page. No wallet, no crypto shown. Served by `server.mjs` at `/rate/:token`. | Served automatically by the backend |
| `install.html` | **Merchant install** — provision embed key + copy-paste snippet for any website. | admin token |
| `public/widget/v1.js` | **Embeddable dangling bubble + chat** for merchant sites. | public key from provision |
| `widget.mjs` | Widget sessions, standby/live routing, **always-learn** from human resolves. | — |
| `WIDGET.md` | Technical API reference for the embed. | — |
| `MERCHANT_GUIDE.md` | **Merchant-facing** step-by-step: put clerk.io on WordPress/Shopify/Webflow/etc. | share this link |
| `supabase/schema-widget.sql` | Widget sessions, shadow drafts, learning events, queue. | run after core schemas |

### How the pages connect
`clerk-neo.html`, `portal.html`, and `reputation.html` all `import` their
network config and contract ABI from **`xlayer.config.mjs`** — one shared
file, not duplicated per page. `landing.html` links to all three plus itself.

`server.mjs` is the **backend service** (webhooks, LLM drafting, chain writes)
— it does not host these pages. Because the pages use real ES module
`import`, serve them over `http(s)` (`npx serve .`, or any static host);
opening them as a `file://` URL will fail — browsers block local module
imports under that protocol.

## 5. Documentation
| File | Purpose |
|---|---|
| `DEPLOY.md` | Step-by-step: testnet deploy → mainnet deploy → backend service setup. Copy-paste runbook. **Start here.** |
| `PRODUCTION.md` | Hardening reference, key-ceremony guidance, monitoring, incident response, staged-rollout checklist. |

---

## Go-live order (summary — see DEPLOY.md for full detail)
1. `npm install`
2. Run the test suite (`npx hardhat test --config hardhat.test.config.cjs`) — confirm 30/30 passing.
3. Deploy: `npx hardhat run scripts/deploy-v2.cjs --network xlayerTestnet` (then `xlayer` for mainnet).
4. Set `window.CLERK_CONTRACT` in `clerk-neo.html`, `portal.html`, and `reputation.html`; serve them with `npx serve .` (not `file://`).
5. Run the 4 SQL files against Supabase, in the order in section 3.
6. Fill `.env` from `.env.example`; run `node server.mjs`.
7. Point your ticket system's webhooks at the server's `/webhooks/*` routes.

## What is deliberately NOT in this package
- Any V1 contract, ABI, or deploy script (superseded by V2 throughout).
- Earlier dashboard iterations (`clerk.html`, `clerk-xlayer.html`) — both were simulated demos with fabricated ticket data; `clerk-neo.html` supersedes them and is wired to the real contract, no simulation.
- The original demo-only backend (`clerk-backend.js`) — `server.mjs` supersedes it with full hardening.
- Any external audit report — per your instruction, auditing is being handled separately before deployment and is out of scope for this package.

## Note on ticket content in the live views
`clerk-neo.html` and `portal.html` show what's actually knowable from the chain alone: ticket hash, status, confidence, payout, reopen action. They do NOT show customer names, message text, or Clerk's drafted reply — that content lives off-chain in Supabase by design (see `schema.sql`), and reading it for a specific merchant requires that merchant's authenticated session, not just a wallet signature. Full ticket content in the UI is a further build (merchant login against Supabase) — not included here.
