# PRODUCTION.md — Clerk launch runbook

This is the path from the hardened codebase to real merchants and real OKB.
Follow it in order. Two items on this list cannot be done by code and are
marked **[HUMAN REQUIRED]** — do not skip them because everything else is done.

---

## 0. What "hardened" means in this codebase

| Threat | Defense | Where |
|---|---|---|
| Malicious/broken payout wallet bricks settlement | Pull payments: `finalize` credits, `claimPayout` transfers | ClerkLedgerV2 |
| Operator key compromised | Two-step rotation (`transferOperator` → `acceptOperator`) + circuit breaker | ClerkLedgerV2 |
| Operator turns hostile / pauses everything | `reopen()` and `withdrawEscrow()` work **even when paused** — merchants always exit | ClerkLedgerV2 |
| Stale-rating score manipulation | 30-day `RATING_WINDOW` after resolution | ClerkLedgerV2 |
| Fake/replayed customer ratings | Signed single-use tokens; `proof_hash` unique in DB **and** committed onchain | server.mjs + schema-production.sql |
| Forged webhooks injecting tickets | HMAC-SHA256 signature, timing-safe compare | server.mjs |
| Duplicate webhook deliveries double-paying | Ticket-hash idempotency at DB + contract (`TicketAlreadyExists` absorbed) | server.mjs |
| Nonce races / dropped txs under load | Serialized TxQueue, explicit nonces, backoff retries | server.mjs |
| LLM returns garbage → bad answer auto-sent | Schema validation, clamped confidence, retry-once, **fail = escalate** | server.mjs |
| Card numbers reaching the LLM | PII scrub on every inbound message | server.mjs |
| Rating-endpoint spam | Per-IP sliding-window rate limits on all public routes | server.mjs |
| One stuck ticket blocks settlement sweep | `finalizeBatch` skips not-ready tickets | ClerkLedgerV2 |
| Cross-merchant memory leakage | RLS on every table + explicit merchant filter (defense in depth) | schema.sql |

---

## 1. Key ceremony **[HUMAN REQUIRED — do first]**

Four distinct keys, four distinct blast radii. Never one key for two jobs.

1. **Deployer** — hardware wallet. Deploys ClerkLedgerV2, then transfers
   operator role to the hot key and goes in a drawer. Touches nothing daily.
2. **Operator (hot)** — the key in `OPERATOR_PRIVATE_KEY`. Lives in your
   secret manager (AWS Secrets Manager / GCP Secret Manager / Vault — never
   a plaintext .env on the box, never in git). Holds **gas OKB only**
   (top up ~5 OKB; alert below 1). If leaked: attacker can submit fake
   resolutions (merchants can reopen them) but **cannot steal escrow or
   payouts** — that's the design working.
3. **Payout wallet** — hardware wallet or multisig. The only address that can
   `claimPayout()`. This is where Clerk's earnings accumulate.
4. **Admin bearer token** — `ADMIN_TOKEN`, for `/admin/pause`. Rotate quarterly.

Rotation drill (practice on testnet before launch):
`transferOperator(newKey)` from old key → `acceptOperator()` from new key →
update secret manager → restart service. Total downtime: seconds.

## 2. External audit **[HUMAN REQUIRED — before mainnet OKB]**

ClerkLedgerV2 compiles clean and its invariants are machine-checked in this
repo, but **that is not an audit**. Before real merchant escrow flows:

- Commission a review from a recognized firm (or at minimum two independent
  Solidity reviewers) scoped to: escrow accounting/solvency, pause asymmetry,
  the reopen/finalize race around the window boundary, and operator-privilege
  abuse cases.
- Run Slither + Foundry invariant tests locally first so paid auditor time
  goes to logic, not lint: the core invariant is
  `sum(deposits) - sum(withdrawals) == sum(free escrow) + sum(locked) + claimable + paidOut-claimed`.
- Budget reality: from a few thousand USD for an independent-reviewer pass.
  If the budget truly doesn't exist yet, launch with **hard caps** (below)
  and say so publicly — capped honest beta beats uncapped unaudited.

## 3. Infrastructure

- **Host** the service (Railway/Fly/Render/ECS — anything) **behind TLS**.
  `app.set('trust proxy', 1)` is already configured for a reverse proxy.
- **Supabase**: run `schema.sql`, then `schema-production.sql`. Deploy the
  `embed` edge function. Point-in-time recovery ON (paid tier) — the DB is
  the off-chain half of your accounting.
- **Two env sets**: staging (testnet, chainId 1952, `REOPEN_WINDOW=300`)
  and production (mainnet 196, `REOPEN_WINDOW=259200` = 72h) — the window is
  a constructor arg at deploy time.
- **Deploy** ClerkLedgerV2 with the deployer key:
  constructor `(payoutWallet, 259200)`. Verify the source on the X Layer
  explorer — merchants must be able to read the contract they're trusting.

## 4. Monitoring & alerts (minimum viable set)

- `/health` polled every 30s (UptimeRobot/Betterstack). Alerts on: down,
  `contractPaused: true` unexpectedly, RPC block number stalling.
- **Reopen rate** — query the `ops_reopen_rate` view; alert > 15% for any
  merchant. High reopens = Clerk misfiring or someone probing the escrow.
- **Operator gas** — alert when balance < 1 OKB (writes stop when it's dry).
- **Escrow solvency** — daily job comparing contract state to the invariant
  above; any drift is a sev-1.
- **Tx failure log lines** (`tx failed permanently`) → page someone.
- **LLM failure rate** — spike in `LLM output invalid` means degraded model
  or prompt regression; tickets fail safe to escalation, but humans drown.

## 5. Staged rollout — never skip stages

1. **Testnet soak (1 week).** Full stack on chainId 1952, synthetic traffic,
   at least one full key-rotation drill and one pause/unpause drill.
2. **Mainnet closed beta (2–4 weeks).** 1–3 friendly merchants. Hard caps:
   `pricePerTicket ≤ 0.1 OKB`, escrow deposits ≤ 50 OKB per merchant
   (enforce in onboarding UI/backend). Daily solvency check by hand.
3. **Open launch.** Only after: audit done, zero solvency drift in beta,
   reopen rate < 10%, and one real incident handled cleanly (you'll have one).

## 6. Incident response

| Incident | Action |
|---|---|
| Bad answers going out | `POST /admin/pause {"paused":true}` — intake and payouts stop; merchants can still reopen and withdraw. Fix, unpause. |
| Operator key leaked | Race condition: only the current operator can rotate, so **speed matters**. Immediately `setPaused(true)` and `transferOperator(standby)` from your copy of the key before the attacker uses theirs. Worst case (attacker rotates first): they hold an operator that can submit fake resolutions — which merchants can reopen — but **cannot touch escrow or payouts**; announce, have merchants withdraw free escrow (always works), redeploy. Keep a standby key ceremonied from day one. Rotate `WEBHOOK_SECRET` + `ADMIN_TOKEN` the same hour regardless. |
| Rating spam wave | Rate limiter absorbs; if targeted, rotate `RATING_TOKEN_SECRET` (invalidates all outstanding links — acceptable). |
| Supabase outage | Chain writes queue and retry; webhooks 500 (senders retry). No money moves incorrectly: escrow logic is fully onchain. |
| RPC outage | TxQueue retries with backoff; switch `XLAYER_RPC` to the fallback (`https://xlayerrpc.okx.com`) and restart. |

## 7. Privacy & compliance **[HUMAN REQUIRED for legal review]**

- Ticket content and PII: off-chain only, by construction. Onchain: hashes,
  scores, timestamps — no personal data.
- GDPR/CCPA deletion: `delete from merchants where id = ...` cascades the
  entire memory namespace. Document this in your DPA. The onchain hash of a
  deleted ticket is not reversible to content.
- Terms of service for merchants must state: pay-per-resolution mechanics,
  the 72h reopen window, that reputation records are public and permanent,
  and the operator trust model (Clerk relays ratings; proof hashes are
  auditable). Have a lawyer read it. This repo is not legal advice.

## 8. Launch-day checklist

- [ ] Audit report received, criticals fixed, report published
- [ ] Keys ceremonied per §1; rotation drill done on testnet
- [ ] ClerkLedgerV2 on mainnet 196, 72h window, source verified on explorer
- [ ] Secrets in a secret manager; `.env` files nowhere in git history
- [ ] Supabase PITR on; both schema files applied; embed function deployed
- [ ] Monitoring live: health, reopen rate, gas, solvency, tx failures
- [ ] Beta caps enforced in onboarding
- [ ] Incident runbook printed/pinned; on-call person named
- [ ] First merchant's escrow deposited; first real ticket resolved; first
      payout claimed to the hardware payout wallet — end to end, small, real
