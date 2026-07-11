# Deploy Clerk on Render (the right pick)

## What goes where

| Piece | Where | Why |
|--------|--------|-----|
| **ClerkReputation** | X Layer **testnet** (already live) | Onchain accuracy record, no escrow — not hosted on Render |
| **Supabase** | Your project `wtaqobfyzhrzbgsrxzsl` | Memory, tickets, ratings, Train Clerk DB |
| **Node API + all HTML pages** | **Render → Web Service** | One public HTTPS URL for everything |

### Do **not** pick Static Site
Static Site only serves HTML. Clerk needs Node for webhooks, Claude drafts, chain txs, and `/rate/:token`.

### Do pick **Web Service**
- Runtime: **Node**
- Build: `npm install`
- Start: `node server.mjs`
- Health check: `/health`
- Root directory: `clerk-golive` (if the repo root is the parent folder)

After deploy, pages are:

| Path | Page |
|------|------|
| `https://YOUR-SERVICE.onrender.com/` | Landing |
| `/portal.html` | Merchant console |
| `/clerk-neo.html` | Onboarding |
| `/reputation.html` | Public track record |
| `/health` | Ops health |

## Env vars to paste in Render Dashboard

| Key | Value |
|-----|--------|
| `ANTHROPIC_API_KEY` | (your Anthropic key) |
| `SUPABASE_URL` | `https://wtaqobfyzhrzbgsrxzsl.supabase.co` |
| `SUPABASE_SERVICE_KEY` | (service_role JWT) |
| `OPERATOR_PRIVATE_KEY` | testnet operator key |
| `CLERK_LEDGER_ADDRESS` | `0x5a067fdaBE4883f6FD1BbFbd0531556411Fc612A` (see `DEPLOYED.md`) |
| `XLAYER_RPC` | `https://xlayer-testnet.drpc.org` |
| `XLAYER_NETWORK` | `testnet` |
| `WEBHOOK_SECRET` | (from local `.env`) |
| `RATING_TOKEN_SECRET` | (from local `.env`) |
| `ADMIN_TOKEN` | (from local `.env`) |
| `TRAIN_SESSION_SECRET` | generate: `openssl rand -hex 32` — required, server won't boot without it |
| `PUBLIC_BASE_URL` | `https://YOUR-SERVICE.onrender.com` (set after first deploy, then redeploy) |

## One-time Supabase schema

1. Open [Supabase SQL Editor](https://supabase.com/dashboard/project/wtaqobfyzhrzbgsrxzsl/sql)
2. Paste contents of `supabase/ALL.sql` → **Run**
3. (Optional) Edge Function `embed` for RAG embeddings — see DEPLOY.md

## Git → Render

Render deploys from GitHub/GitLab. Push this folder (or monorepo) and connect the repo in Render → New → Web Service.
`render.yaml` in this folder is a Blueprint for the same setup.

## Local right now

```bash
cd clerk-golive
node server.mjs
# http://localhost:8080
```
