# clerk.io without OKB payment — accuracy still onchain

## Yes, it’s possible

You can **stop charging merchants OKB for resolutions** and still keep a **public, permanent accuracy record** on X Layer.

| Still onchain | Removed |
|---------------|---------|
| Ticket hash (no PII) | Escrow deposits |
| Confidence at resolve | Price per ticket |
| Solo vs human-assisted | Locked payouts |
| Reopen (voids accuracy claim) | claimPayout / paid OKB |
| Customer ★ ratings (customer-only, no merchant self-rating) | Any fee to Clerk |
| Bayesian scores + track record | |

Merchants may still hold a little **native OKB for gas** when they sign wallet txs (register, reopen). That is **network gas**, not a product fee — and merchants don't even need to source it themselves: `POST /api/gas-drip` sends a one-time OKB drip from Clerk's operator wallet when a wallet's balance is too low, so onboarding never requires the merchant to hold crypto first. See `supabase/schema-gasdrip.sql` and `GAS_DRIP_WEI`/`GAS_DRIP_DAILY_CAP` in `.env.example`.

## Contract

**`ClerkReputation.sol`** — new ledger (replaces payment path of V2 for new deploys).

V2 remains in the repo for reference; production path is Reputation.

Deploy:

```bash
npx hardhat run scripts/deploy-reputation.cjs --network xlayerTestnet
```

Then set:

- `window.CLERK_CONTRACT` on front-ends  
- `CLERK_LEDGER_ADDRESS` on Render / `.env`  

## What merchants do now

1. Connect wallet  
2. `registerMerchant()` — **free**  
3. Embed widget / use care flow  
4. Accuracy lands onchain as tickets resolve & get rated  

No “fund escrow” step.
