# Live deployment — X Layer Testnet

| Field | Value |
|---|---|
| Network | X Layer Testnet |
| Chain ID | **1952** |
| Contract | **`0x6020b4475326480da78b3D166C5476639e450837`** |
| Deployer / operator / payout (demo) | `0xfF30A76d10442dDBbBe76d2E4313D39d3928FB84` |
| Reopen window | 60 seconds (testnet) |
| Explorer | https://www.okx.com/web3/explorer/xlayer-test/address/0x6020b4475326480da78b3D166C5476639e450837 |

## Lifecycle already run on-chain
Deploy script completed one full ticket: register → resolve → rate → finalize → claim.
Track record at deploy: **1 solo**, **0.001 OKB** paid out, customer score **3.57**.

## Pages (all wired to testnet)
Serve this folder over HTTP (not `file://`):

```bash
npx serve . -l 5173
```

| Page | URL |
|---|---|
| Landing | http://localhost:5173/landing.html |
| Onboarding + dashboard | http://localhost:5173/clerk-neo.html |
| Merchant console | http://localhost:5173/portal.html |
| Public track record | http://localhost:5173/reputation.html |

Bootstrap in each page:
```js
window.CLERK_NETWORK = "testnet";
window.CLERK_CONTRACT = "0x6020b4475326480da78b3D166C5476639e450837";
```

To go mainnet later: deploy with `--network xlayer`, then set `CLERK_NETWORK = "mainnet"` and the new address. No other code changes required.

## Wallet setup for merchants
1. OKX Wallet or MetaMask
2. Add X Layer Testnet (pages auto-prompt if missing):
   - RPC: `https://xlayer-testnet.drpc.org` (fallback `https://testrpc.xlayer.tech/terigon`)
   - Chain ID: `1952`
   - Symbol: `OKB`
3. Fund with faucet: https://web3.okx.com/xlayer/faucet
4. Open portal → Connect → Register & deposit escrow

## Backend (optional next step)
Full ticket answering needs Supabase + Anthropic env vars (see `.env.example`).
Front-ends work for wallet + escrow + reputation without the backend.
