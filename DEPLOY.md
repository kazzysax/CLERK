# DEPLOY.md — Clerk deployment runbook

A straight, copy-paste path from the repo to a live Clerk on X Layer.
Do the **testnet** track first (30–40 min, free), confirm everything works
end to end, then repeat the same steps on **mainnet**.

> Prereqs: Node 18+, a terminal, and a browser wallet (OKX Wallet or MetaMask).

---

## Track A — Testnet (do this first)

### A1. Install
```bash
npm install
# dev deps for deploy + tests, if not already present:
npm install --save-dev hardhat@^2.26 @nomicfoundation/hardhat-ethers@^3 ethers@^6 dotenv
```

### A2. Create a deployer wallet + get test OKB
1. In your wallet, create a fresh account for deploying (don't reuse a personal one).
2. Add X Layer Testnet if it isn't there:
   - Network name: `X Layer Testnet`
   - RPC: `https://testrpc.xlayer.tech/terigon`
   - Chain ID: `1952`
   - Currency symbol: `OKB`
   - Explorer: `https://www.okx.com/web3/explorer/xlayer-test`
3. Get test OKB from the faucet: `https://www.okx.com/xlayer/faucet` (0.01 OKB/day is plenty for deploy + demo).
4. Export that account's private key — you'll put it in `.env` next.

### A3. Configure env
```bash
cp env.example .env
```
For a **deploy-only** run you just need the deploy key. Open `.env` and set:
```
PRIVATE_KEY=0xyourDeployerKey        # used by deploy-v2.cjs / hardhat.config.cjs
```
(The full server env is only needed when you run the backend — Track C.)

### A4. Deploy the contract
`deploy-v2.cjs` deploys **ClerkLedgerV2** and, on testnet, walks one full ticket
lifecycle so you immediately see real transactions on the explorer.

First point the deploy at V2 (the hardened contract). In `deploy-v2.cjs`, confirm
the factory line reads:
```js
const Ledger = await hre.ethers.getContractFactory("ClerkLedgerV2");
```
and the constructor uses a short window for the demo:
```js
const REOPEN_WINDOW = net === "xlayer" ? 259200 : 60;  // 72h mainnet, 60s testnet
const ledger = await Ledger.deploy(deployer.address, REOPEN_WINDOW);
```
Then run:
```bash
npx hardhat run scripts/deploy-v2.cjs --config hardhat.config.cjs --network xlayerTestnet
```
Copy the printed **contract address**. Open it on the testnet explorer and
confirm the lifecycle transactions (register → submit → rate → finalize) are there.

### A5. Wire the front-ends
The three pages that read/write the contract (`clerk-neo.html`, `portal.html`,
`reputation.html`) `import` their network config and ABI from `xlayer.config.mjs`
— one shared file, not duplicated per page. Set the contract address once:
```html
<script>window.CLERK_CONTRACT = "0xYourDeployedAddress";</script>
```
Add that line near the top of each of the three files, before their
`<script type="module">` tag. For testnet, also point `xlayer.config.mjs`'s
usage in those pages at `XL.testnet` instead of `XL.mainnet` (one line each).

**Important:** because these pages use real ES module `import`, they must be
served over `http(s)` — e.g. `npx serve .` in this folder — not opened directly
as a `file://` URL, which browsers block from importing local modules.
`server.mjs` is the backend (webhooks, LLM, chain writes) and does not host
these pages; use `npx serve .` or any static host for that.

### A6. See it live
```bash
npx serve .
```
Open the printed local URL, go to `portal.html`:
- Connect wallet → it prompts to switch to X Layer.
- Register & fund escrow → real `registerMerchant` tx.
- Open **reputation.html** → the track record reads live from your contract.

That's a fully live, clickable, real-onchain Clerk. 

---

## Track B — Mainnet

Identical to Track A with three changes:

1. **Network**: use `--network xlayer` (chain **196**, RPC `https://rpc.xlayer.tech`).
   Fund the deployer with real OKB (withdraw from OKX Exchange to X Layer, or
   bridge via `https://www.okx.com/xlayer/bridge`).
2. **Reopen window**: deploy with the production value — `259200` (72h). The
   `deploy-v2.cjs` conditional already does this when `net === "xlayer"`.
3. **Front-ends**: set `window.CLERK_CONTRACT` in each of the three pages to
   the mainnet address. They already import from `xlayer.config.mjs` at
   `XL.mainnet` by default. Serve them via `npx serve .` or any static host
   (not `file://` — see A5).

```bash
npx hardhat run scripts/deploy-v2.cjs --config hardhat.config.cjs --network xlayer
```
Verify the contract source on the OKX explorer so merchants can read what they're
trusting.

---

## Track C — Backend service (when you're ready for live tickets)

The front-ends work read/write on their own; the **server** is what makes Clerk
actually answer tickets. Bring it up when you want the full loop.

### C1. Supabase
1. Create a project. In the SQL editor, run in order:
   `schema.sql` → `schema-production.sql` → `schema-conversations.sql` → `schema-calibration.sql`
2. Deploy the embed edge function — create `supabase/functions/embed/index.ts` with:
   ```ts
   const model = new Supabase.ai.Session('gte-small');
   Deno.serve(async (req) => {
     const { text } = await req.json();
     const embedding = await model.run(text, { mean_pool: true, normalize: true });
     return new Response(JSON.stringify({ embedding }), { headers: { 'Content-Type': 'application/json' } });
   });
   ```
   then:
   ```bash
   supabase functions deploy embed
   ```
3. Confirm the `merchant-docs` storage bucket exists (schema.sql creates it).

### C2. Fill the full `.env`
Set every value in `env.example`:
- Supabase URL + service key
- `ANTHROPIC_API_KEY`
- `OPERATOR_PRIVATE_KEY` (the hot key that signs registerTicket/submitResolution/ratings — **not** the deployer, **not** the payout wallet; fund it with a few OKB for gas)
- `CLERK_LEDGER_ADDRESS` (from Track A/B)
- `XLAYER_RPC`, `XLAYER_NETWORK` (`testnet` or `mainnet`)
- `WEBHOOK_SECRET`, `RATING_TOKEN_SECRET`, `ADMIN_TOKEN` — generate each with `openssl rand -hex 32`
- `PUBLIC_BASE_URL`
- Optional: `OKX_API_KEY` / `_SECRET` / `_PASSPHRASE` to enable live swap quotes

### C3. Run
```bash
node server.mjs
```
Behind TLS in production (reverse proxy — `trust proxy` is already set).
Health check: `GET /health` returns block number and pause state.

### C4. Point your ticket system at it
Implement the two adapters at the bottom of `server.mjs`
(`sendReplyToTicketSystem`, `assignToHuman`) for your helpdesk, and configure
its webhooks to hit:
- `POST /webhooks/ticket` — new ticket
- `POST /webhooks/ticket-reply` — customer replied (drives multi-turn)
- `POST /webhooks/resolved-by-human` — human closed an escalation
- `POST /webhooks/reopened` — external reopen
All must send the `X-Clerk-Signature` HMAC header (see `verifyWebhook`).

---

## Contract addresses to record after deploy

| Network | Chain ID | RPC | Contract |
|---|---|---|---|
| Testnet | 1952 | https://testrpc.xlayer.tech/terigon | `0x…` |
| Mainnet | 196 | https://rpc.xlayer.tech | `0x…` |

Keep these somewhere shared — the front-ends, the server env, and anyone
verifying the track record all reference them.

---

## Fast path (the 30-minute testnet demo)

1. `npm install`
2. fund a deployer with faucet OKB
3. `PRIVATE_KEY=…` in `.env`
4. `npx hardhat run scripts/deploy-v2.cjs --config hardhat.config.cjs --network xlayerTestnet`
5. put the address in `window.CLERK_CONTRACT` in the three chain-reading pages, then `npx serve .` and open `portal.html`
6. open portal.html → connect → register → done: live onchain Clerk.
