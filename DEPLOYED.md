# Live deployment — X Layer Testnet

| Field | Value |
|---|---|
| Network | X Layer Testnet |
| Chain ID | **1952** |
| Contract | **`ClerkReputation`** at **`0x5a067fdaBE4883f6FD1BbFbd0531556411Fc612A`** |
| Deployer / operator (demo) | `0xfF30A76d10442dDBbBe76d2E4313D39d3928FB84` |
| Reopen window | 60 seconds (testnet) |
| Explorer | https://www.okx.com/web3/explorer/xlayer-test/address/0x5a067fdaBE4883f6FD1BbFbd0531556411Fc612A |

No escrow, no OKB fee to clerk.io, no merchant self-rating — see `NO_FEES.md`. The
address above supersedes an earlier `ClerkLedgerV2` deployment at
`0x6020b4475326480da78b3D166C5476639e450837`, which the frontend had been
mistakenly still pointed at (ABI mismatch — every `registerMerchant()` call was
reverting with "missing revert data"). Fixed by redeploying `ClerkReputation`
and repointing every page.

## Lifecycle already run on-chain
Deploy script completed one full ticket: register → resolve → rate → finalize.
Track record at deploy: **1 solo**, **1 finalized**, customer score **3.57**.

## Pages (all wired to testnet)
Served by `server.mjs` on Render (`https://clerk-io.onrender.com`), or locally via `npx serve .`:

| Page | Path |
|---|---|
| Landing | `/landing.html` |
| Onboarding + dashboard | `/clerk-neo.html` |
| Merchant console | `/portal.html` |
| Public track record | `/reputation.html` |

Bootstrap in each page:
```js
window.CLERK_NETWORK = "testnet";
window.CLERK_CONTRACT = "0x5a067fdaBE4883f6FD1BbFbd0531556411Fc612A";
```

To go mainnet later: deploy with `--network xlayer`, then set `CLERK_NETWORK = "mainnet"` and the new address in all four pages plus `CLERK_LEDGER_ADDRESS` on Render.

## Signing in

Two ways in, same account underneath — see `schema-auth-link.sql`:
- **Connect Wallet** — free `registerMerchant()`, gas sponsored automatically if the wallet is empty (`/api/gas-drip`).
- **Continue with Google** — full dashboard access (Train Clerk: FAQ upload + tutoring) with no wallet yet; link one later from inside the dashboard.

## Backend
Full ticket answering, FAQ upload, and tutoring need Supabase + Anthropic env vars (see `.env.example`) — already configured on the `clerk-io` Render service. Front-ends work for wallet connect + onchain reputation even if the backend is down.
