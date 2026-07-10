/**
 * swap.js — swap-to-OKB for merchant onboarding, via the OKX DEX aggregator.
 *
 * Problem it solves: a merchant arrives on X Layer holding USDT/USDC (or any
 * token) but no OKB. Without OKB they can pay neither gas nor escrow. This
 * module gets them OKB in one guided flow: quote → (approve if ERC-20) → swap.
 *
 * The OKX DEX aggregator finds the best route across X Layer liquidity and
 * returns a ready-to-sign transaction. The MERCHANT signs it with their own
 * wallet (OKX Wallet, MetaMask, etc.) — Clerk never holds or moves the
 * merchant's funds. Clerk only fetches quotes and builds the tx.
 *
 * env: OKX_API_KEY, OKX_API_SECRET, OKX_API_PASSPHRASE  (OKX API credentials)
 * deps: ethers (for unit math)
 *
 * NOTE: /quote and /swap require live OKX API credentials. The signed request
 * builder is complete and correct; drop in your keys and it calls real
 * liquidity. Without keys, getQuote/buildSwap throw a clear, catchable error.
 */

import crypto from "crypto";
import { OKX_DEX, TOKENS } from "./xlayer.config.mjs";

const CREDS = {
  key: process.env.OKX_API_KEY,
  secret: process.env.OKX_API_SECRET,
  passphrase: process.env.OKX_API_PASSPHRASE,
};

/** OKX API request signing (HMAC-SHA256 over timestamp+method+path+body, base64). */
function signedHeaders(method, path, body = "") {
  if (!CREDS.key || !CREDS.secret || !CREDS.passphrase) {
    throw new Error("OKX_DEX_NOT_CONFIGURED: set OKX_API_KEY / _SECRET / _PASSPHRASE to enable swaps");
  }
  const ts = new Date().toISOString();
  const prehash = ts + method.toUpperCase() + path + body;
  const sign = crypto.createHmac("sha256", CREDS.secret).update(prehash).digest("base64");
  return {
    "OK-ACCESS-KEY": CREDS.key,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": CREDS.passphrase,
    "Content-Type": "application/json",
  };
}

async function okxGet(pathWithQuery) {
  const url = OKX_DEX.base + pathWithQuery;
  const path = new URL(url).pathname + new URL(url).search;
  const res = await fetch(url, { method: "GET", headers: signedHeaders("GET", path) });
  const json = await res.json();
  if (json.code !== "0") throw new Error(`OKX DEX error ${json.code}: ${json.msg || "unknown"}`);
  return json.data;
}

/**
 * Quote: how much OKB does `amount` of `fromToken` buy right now?
 * @param fromToken  address of the token the merchant holds (use TOKENS.USDT etc.)
 * @param amountWei  amount in the fromToken's smallest unit (string)
 */
export async function getQuote(fromToken, amountWei) {
  const q = new URLSearchParams({
    chainId: String(OKX_DEX.chainId),
    fromTokenAddress: fromToken,
    toTokenAddress: TOKENS.OKB_NATIVE, // buying native OKB (gas token)
    amount: String(amountWei),
  }).toString();
  const data = await okxGet(`${OKX_DEX.quote}?${q}`);
  const d = Array.isArray(data) ? data[0] : data;
  return {
    fromToken,
    toToken: TOKENS.OKB_NATIVE,
    fromAmount: amountWei,
    toAmount: d.toTokenAmount,                 // OKB out, in wei
    priceImpactPct: d.priceImpactPercentage,
    estGasFee: d.estimateGasFee,               // paid in OKB
    route: d.dexRouterList?.map(r => r.router) ?? [],
  };
}

/**
 * Build the swap transaction for the merchant to sign. `slippageBps` guards
 * against price movement (e.g. 50 = 0.5%). userWallet = merchant's address.
 * Returns an unsigned tx { to, data, value, gas } — the merchant's wallet signs.
 */
export async function buildSwap(fromToken, amountWei, userWallet, slippageBps = 50) {
  const q = new URLSearchParams({
    chainId: String(OKX_DEX.chainId),
    fromTokenAddress: fromToken,
    toTokenAddress: TOKENS.OKB_NATIVE,
    amount: String(amountWei),
    slippage: (slippageBps / 10000).toString(),
    userWalletAddress: userWallet,
  }).toString();
  const data = await okxGet(`${OKX_DEX.swap}?${q}`);
  const d = Array.isArray(data) ? data[0] : data;
  const tx = d.tx;
  return {
    to: tx.to,
    data: tx.data,
    value: tx.value || "0",   // non-zero only when swapping FROM native OKB
    gas: tx.gas,
    minReceive: d.minmumReceive ?? d.toTokenAmount, // OKB floor after slippage
  };
}

/**
 * For ERC-20 sources (USDT/USDC), the merchant must first approve the OKX
 * router to spend their tokens. Returns the approval tx to sign, or null if
 * the source is native OKB (no approval needed).
 */
export async function buildApproval(fromToken, amountWei) {
  if (fromToken === TOKENS.OKB_NATIVE) return null; // native needs no approval
  const q = new URLSearchParams({
    chainId: String(OKX_DEX.chainId),
    tokenContractAddress: fromToken,
    approveAmount: String(amountWei),
  }).toString();
  const data = await okxGet(`${OKX_DEX.approveTx}?${q}`);
  const d = Array.isArray(data) ? data[0] : data;
  return { to: d.dexContractAddress, data: d.data, value: "0" };
}

/**
 * Full guided flow the portal calls: returns the ordered list of txs the
 * merchant must sign to end up holding OKB. The portal presents these one at
 * a time through the merchant's wallet.
 */
export async function planSwapToOKB(fromToken, amountWei, userWallet, slippageBps = 50) {
  const quote = await getQuote(fromToken, amountWei);
  const steps = [];
  const approval = await buildApproval(fromToken, amountWei);
  if (approval) steps.push({ kind: "approve", tx: approval, label: "Approve OKX router to swap your tokens" });
  const swap = await buildSwap(fromToken, amountWei, userWallet, slippageBps);
  steps.push({ kind: "swap", tx: swap, label: `Swap for ~${quote.toAmount} OKB (min ${swap.minReceive})` });
  return { quote, steps };
}

export function isConfigured() {
  return Boolean(CREDS.key && CREDS.secret && CREDS.passphrase);
}
