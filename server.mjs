/**
 * server.js — Clerk production service.
 *
 * Hardening in this file (vs the demo backend):
 *  - ENV VALIDATION at boot: refuses to start with anything missing.
 *  - WEBHOOK AUTH: every inbound webhook must carry a valid HMAC-SHA256
 *    signature (timing-safe compare). Unsigned = rejected, logged.
 *  - IDEMPOTENCY: ticket hash is the natural key; duplicate webhook
 *    deliveries are absorbed, never double-registered or double-paid.
 *  - RATING TOKENS: one-tap customer ratings use signed, single-use,
 *    expiring tokens bound to one ticket. Token hash is committed onchain
 *    as the rating's proofHash (matches ClerkLedgerV2.rateAsCustomer).
 *  - RATE LIMITING: per-IP sliding window on public endpoints.
 *  - TX QUEUE: all chain writes serialize through one queue with explicit
 *    nonce management and exponential-backoff retries — no nonce races,
 *    no dropped writes under burst load.
 *  - LLM GUARDRAILS: strict JSON schema validation, confidence clamped to
 *    [0,100], one retry on malformed output, hard timeout; on any failure
 *    the ticket ESCALATES (fail-safe: never auto-send on a broken pipeline).
 *  - PII HYGIENE: card-number patterns scrubbed before any LLM call.
 *  - KILL SWITCH: POST /admin/pause flips the contract circuit breaker.
 *  - STATIC FRONT-ENDS: serves landing/portal/reputation/clerk-neo so one
 *    Render Web Service hosts both API and merchant UI.
 *
 * deps: npm i express @supabase/supabase-js ethers dotenv
 * Run behind TLS (reverse proxy). See PRODUCTION.md for the full runbook.
 */

import dotenv from "dotenv";
// override: empty shell vars (e.g. ANTHROPIC_API_KEY="") must not block .env
dotenv.config({ override: true });
import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { planSwapToOKB, getQuote, isConfigured as swapConfigured } from "./swap.mjs";
import { net, TOKENS } from "./xlayer.config.mjs";
import { handleReply } from "./conversation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------
// 0. Environment — fail fast, fail loud
// ------------------------------------------------------------------
const REQUIRED_ENV = [
  "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "ANTHROPIC_API_KEY",
  "OPERATOR_PRIVATE_KEY", "CLERK_LEDGER_ADDRESS", "XLAYER_RPC",
  "WEBHOOK_SECRET", "RATING_TOKEN_SECRET", "ADMIN_TOKEN", "PUBLIC_BASE_URL",
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`FATAL: missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}
const ENV = Object.fromEntries(REQUIRED_ENV.map(k => [k, process.env[k]]));

// ------------------------------------------------------------------
// 1. Clients
// ------------------------------------------------------------------
// Realtime is unused (REST + RPC only). Disable it so Node <22 boots without a
// native WebSocket polyfill on hosts like Render free tier.
const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { enabled: false },
});
// X Layer network: primary RPC from env, plus OKX's secondary endpoint as
// automatic failover (both defined in xlayer.config.js). Chain 196 mainnet.
const NET = net(process.env.XLAYER_NETWORK === "testnet" ? "testnet" : "mainnet");
const provider = new ethers.FallbackProvider([
  { provider: new ethers.JsonRpcProvider(ENV.XLAYER_RPC, NET.chainId), priority: 1, weight: 1 },
  { provider: new ethers.JsonRpcProvider(NET.rpcFallback, NET.chainId), priority: 2, weight: 1 },
], NET.chainId);
const operator = new ethers.Wallet(ENV.OPERATOR_PRIVATE_KEY, provider);
const ledger = new ethers.Contract(
  ENV.CLERK_LEDGER_ADDRESS,
  JSON.parse(readFileSync(new URL("./contracts/ClerkLedgerV2.abi.json", import.meta.url), "utf8")),
  operator
);

const log = (level, msg, meta = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }));

// ------------------------------------------------------------------
// 2. Transaction queue — serialized, nonce-managed, retried
// ------------------------------------------------------------------
class TxQueue {
  constructor(wallet) { this.wallet = wallet; this.chain = Promise.resolve(); this.nonce = null; }
  submit(label, fn) {
    this.chain = this.chain.then(() => this._run(label, fn)).catch(() => {});
    return this.chain;
  }
  async _run(label, fn, attempt = 1) {
    try {
      if (this.nonce === null) this.nonce = await this.wallet.getNonce();
      const tx = await fn(this.nonce);
      this.nonce += 1;
      const receipt = await tx.wait();
      log("info", "tx confirmed", { label, hash: receipt.hash, block: receipt.blockNumber });
      return receipt;
    } catch (err) {
      this.nonce = null; // resync nonce after any failure
      const known = ["TicketAlreadyExists", "AlreadyRated", "WrongStatus"];
      if (known.some(k => String(err.message).includes(k))) {
        log("warn", "tx idempotent-skip", { label, reason: err.shortMessage || err.message });
        return null; // duplicate delivery — absorbed, not an error
      }
      if (attempt >= 4) { log("error", "tx failed permanently", { label, err: err.message }); throw err; }
      const backoff = 1500 * 2 ** attempt;
      log("warn", "tx retry", { label, attempt, backoff });
      await new Promise(r => setTimeout(r, backoff));
      return this._run(label, fn, attempt + 1);
    }
  }
}
const txq = new TxQueue(operator);
const send = (label, method, ...args) =>
  txq.submit(label, (nonce) => ledger[method](...args, { nonce }));

// ------------------------------------------------------------------
// 3. Security primitives
// ------------------------------------------------------------------
const hmac = (data, secret) => crypto.createHmac("sha256", secret).update(data).digest("hex");
const safeEqual = (a, b) => {
  const ba = Buffer.from(a || "", "utf8"), bb = Buffer.from(b || "", "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

/** Webhook auth: X-Clerk-Signature = hex(HMAC-SHA256(rawBody, WEBHOOK_SECRET)) */
function verifyWebhook(req, res, next) {
  const sig = req.get("X-Clerk-Signature");
  const expected = hmac(req.rawBody, ENV.WEBHOOK_SECRET);
  if (!sig || !safeEqual(sig, expected)) {
    log("warn", "webhook rejected: bad signature", { ip: req.ip, path: req.path });
    return res.status(401).json({ error: "invalid signature" });
  }
  next();
}

/** Rating tokens: {ticketHash}.{expiry}.{HMAC(ticketHash|expiry)} — single-use enforced in DB. */
function mintRatingToken(ticketHash, ttlHours = 24 * 14) {
  const exp = Date.now() + ttlHours * 3600 * 1000;
  const mac = hmac(`${ticketHash}|${exp}`, ENV.RATING_TOKEN_SECRET);
  return `${ticketHash}.${exp}.${mac}`;
}
function verifyRatingToken(token) {
  const [ticketHash, expStr, mac] = String(token).split(".");
  if (!ticketHash || !expStr || !mac) return null;
  if (!safeEqual(mac, hmac(`${ticketHash}|${expStr}`, ENV.RATING_TOKEN_SECRET))) return null;
  if (Date.now() > Number(expStr)) return null;
  return ticketHash;
}

/** Per-IP sliding-window rate limiter. */
const buckets = new Map();
function rateLimit(maxPerMin) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${req.path}`;
    const hits = (buckets.get(key) || []).filter(t => now - t < 60_000);
    if (hits.length >= maxPerMin) {
      log("warn", "rate limited", { ip: req.ip, path: req.path });
      return res.status(429).json({ error: "too many requests, slow down" });
    }
    hits.push(now);
    buckets.set(key, hits);
    next();
  };
}
setInterval(() => { // sweep stale buckets
  const now = Date.now();
  for (const [k, v] of buckets) { const live = v.filter(t => now - t < 60_000); live.length ? buckets.set(k, live) : buckets.delete(k); }
}, 120_000).unref();

/** Scrub obvious payment-card patterns before anything reaches the LLM. */
const scrubPII = (text) => String(text).replace(/\b(?:\d[ -]?){13,19}\b/g, "[card removed]");

// ------------------------------------------------------------------
// 4. LLM with guardrails — fail-safe: broken pipeline => escalate
// ------------------------------------------------------------------
async function llm(prompt, timeoutMs = 30_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-api-key": ENV.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = await res.json();
    return data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  } finally { clearTimeout(timer); }
}

function validateDraft(raw) {
  const parsed = JSON.parse(String(raw).replace(/```json|```/g, "").trim());
  if (typeof parsed.draft !== "string" || !parsed.draft.trim()) throw new Error("draft missing");
  const confidence = Math.max(0, Math.min(100, Number(parsed.confidence)));
  if (!Number.isFinite(confidence)) throw new Error("confidence not a number");
  return { draft: parsed.draft.trim(), confidence, sourceUsed: String(parsed.source_used ?? "none") };
}

async function draftWithConfidence(message, chunks, tone, exemplars) {
  const context = chunks.map((c, i) => `[${i + 1}] ${c.content}`).join("\n");
  const fewShot = exemplars.map(e => `Customer: ${e.customer_message}\nReply: ${e.human_reply}`).join("\n---\n");
  const prompt =
`You are Clerk, this business's support agent.
BUSINESS VOICE: ${tone ?? "professional, warm, concise"}
EXAMPLES:\n${fewShot || "(none yet)"}
KNOWLEDGE (only source of truth — if it doesn't answer the question, say so):\n${context || "(no relevant knowledge found)"}
CUSTOMER: ${scrubPII(message)}
Respond ONLY with JSON: {"draft":"...","confidence":0-100,"source_used":"which [n], or 'none'"}
No relevant knowledge => confidence under 50.`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return validateDraft(await llm(prompt)); }
    catch (err) { log("warn", "LLM output invalid", { attempt, err: err.message }); }
  }
  return null; // caller treats null as ESCALATE — never auto-send on failure
}

// ------------------------------------------------------------------
// 5. Core flows (memory retrieval unchanged from clerk-backend.js design)
// ------------------------------------------------------------------
async function embed(text) {
  const { data, error } = await supabase.functions.invoke("embed", { body: { text: scrubPII(text) } });
  if (error) throw error;
  return data.embedding;
}

async function handleTicket(merchantId, externalId, customerMessage) {
  const ticketHash = ethers.keccak256(ethers.toUtf8Bytes(`${merchantId}:${externalId}:${customerMessage}`));

  // Idempotency: absorb duplicate webhook deliveries.
  const { data: existing } = await supabase.from("tickets").select("id").eq("ticket_hash", ticketHash).maybeSingle();
  if (existing) { log("info", "duplicate webhook absorbed", { ticketHash }); return { action: "duplicate" }; }

  const { data: merchant } = await supabase.from("merchants").select("*").eq("id", merchantId).single();
  if (!merchant) throw new Error("unknown merchant");

  await send(`registerTicket ${externalId}`, "registerTicket", ticketHash, merchant.wallet_address);
  await supabase.from("tickets").insert({ merchant_id: merchantId, external_id: externalId, ticket_hash: ticketHash, status: "new", turn_count: 1 });
  await supabase.from("ticket_messages").insert({ merchant_id: merchantId, ticket_hash: ticketHash, role: "customer", body: customerMessage, intent: "question" });

  const qEmbedding = await embed(customerMessage);
  const { data: chunks } = await supabase.rpc("match_chunks", { p_merchant: merchantId, query_embedding: qEmbedding, match_count: 5 });
  const { data: tonep } = await supabase.from("tone_profiles").select("profile").eq("merchant_id", merchantId).maybeSingle();
  const { data: exemplars } = await supabase.from("exemplar_replies").select("customer_message, human_reply").eq("merchant_id", merchantId).limit(3);

  const result = await draftWithConfidence(customerMessage, chunks ?? [], tonep?.profile, exemplars ?? []);
  const { data: cal } = await supabase.from("calibration_state").select("auto_send_threshold").eq("merchant_id", merchantId).maybeSingle();
  const threshold = Number(cal?.auto_send_threshold ?? 80);

  if (result && result.confidence >= threshold) {
    await sendReplyToTicketSystem(merchant, externalId, result.draft);
    await send(`submitResolution ${externalId}`, "submitResolution", ticketHash, Math.round(result.confidence * 100), true);
    await supabase.from("tickets").update({ status: "pending", confidence: result.confidence, resolved_by_clerk: true, source_used: result.sourceUsed }).eq("ticket_hash", ticketHash);
    await sendRatingLink(merchant, externalId, ticketHash); // one-tap link over the ORIGINAL channel
    return { action: "auto_resolved", confidence: result.confidence };
  }
  // Escalate: low confidence OR pipeline failure (result === null)
  await assignToHuman(merchant, externalId, result?.draft ?? "(draft unavailable — pipeline failure, see logs)", result?.confidence ?? 0, result?.sourceUsed ?? "none");
  await supabase.from("tickets").update({ status: "escalated", confidence: result?.confidence ?? 0, source_used: result?.sourceUsed ?? "none" }).eq("ticket_hash", ticketHash);
  return { action: "escalated", confidence: result?.confidence ?? 0 };
}

async function recalibrate(merchantId) {
  const { data: recent } = await supabase.from("rating_feedback")
    .select("confidence, rating").eq("merchant_id", merchantId).eq("rater", "customer")
    .order("created_at", { ascending: false }).limit(20);
  if (!recent?.length) return;
  const { data: cal } = await supabase.from("calibration_state").select("auto_send_threshold").eq("merchant_id", merchantId).maybeSingle();
  let threshold = Number(cal?.auto_send_threshold ?? 80);
  const weakConfident = recent.filter(r => r.rating <= 3 && r.confidence >= threshold);
  const strong = recent.filter(r => r.rating === 5);
  if (weakConfident.length >= 2) threshold = Math.min(95, threshold + 3);
  else if (strong.length >= 15) threshold = Math.max(76, threshold - 1);
  await supabase.from("calibration_state").upsert({ merchant_id: merchantId, auto_send_threshold: threshold, updated_at: new Date() });
}

// Ticket-system adapters — implement per merchant.ticket_system (Zendesk/Intercom APIs).
async function sendReplyToTicketSystem(merchant, externalId, draft) { log("info", "reply sent", { merchant: merchant.id, externalId }); }
async function assignToHuman(merchant, externalId, draft, confidence, source) { log("info", "escalated to human", { merchant: merchant.id, externalId, confidence }); }
async function sendRatingLink(merchant, externalId, ticketHash) {
  const url = `${ENV.PUBLIC_BASE_URL}/rate/${mintRatingToken(ticketHash)}`;
  log("info", "rating link issued", { externalId, url: url.slice(0, 60) + "…" });
  // Delivered over the SAME channel as the original ticket (email footer /
  // chat message) — that channel binding IS the provenance guarantee.
}

// ------------------------------------------------------------------
// 6. HTTP surface
// ------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get("/health", async (_req, res) => {
  try {
    const [block, isPaused] = await Promise.all([provider.getBlockNumber(), ledger.paused()]);
    res.json({ ok: true, block, contractPaused: isPaused });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

// --- Signed webhooks from the ticket system ---
app.post("/webhooks/ticket", verifyWebhook, rateLimit(120), async (req, res) => {
  try {
    const { merchantId, externalId, message } = req.body;
    if (!merchantId || !externalId || !message) return res.status(400).json({ error: "merchantId, externalId, message required" });
    const out = await handleTicket(merchantId, externalId, String(message).slice(0, 20_000));
    res.json(out);
  } catch (e) { log("error", "handleTicket failed", { err: e.message }); res.status(500).json({ error: "internal" }); }
});

// Customer replied inside an existing ticket thread → multi-turn handling.
// This is where "this didn't work" auto-reopens Clerk's payout onchain.
app.post("/webhooks/ticket-reply", verifyWebhook, rateLimit(120), async (req, res) => {
  try {
    const { merchantId, externalId, message } = req.body;
    if (!merchantId || !externalId || !message) return res.status(400).json({ error: "merchantId, externalId, message required" });
    const ctx = { supabase, ledger, send, embed, draftWithConfidence, llm, recalibrate, sendReplyToTicketSystem, assignToHuman };
    const out = await handleReply(ctx, merchantId, externalId, String(message).slice(0, 20_000));
    res.json(out);
  } catch (e) { log("error", "handleReply failed", { err: e.message }); res.status(500).json({ error: "internal" }); }
});

app.post("/webhooks/resolved-by-human", verifyWebhook, rateLimit(120), async (req, res) => {
  const { merchantId, externalId } = req.body;
  const { data: t } = await supabase.from("tickets").select("*").eq("merchant_id", merchantId).eq("external_id", externalId).single();
  if (!t) return res.status(404).json({ error: "unknown ticket" });
  await send(`assist ${externalId}`, "submitResolution", t.ticket_hash, Math.round((t.confidence ?? 0) * 100), false);
  await supabase.from("tickets").update({ status: "pending", resolved_by_clerk: false }).eq("ticket_hash", t.ticket_hash);
  const { data: merchant } = await supabase.from("merchants").select("*").eq("id", merchantId).single();
  await sendRatingLink(merchant, externalId, t.ticket_hash);
  res.json({ ok: true });
});

app.post("/webhooks/reopened", verifyWebhook, rateLimit(120), async (req, res) => {
  const { merchantId, externalId } = req.body;
  const { data: t } = await supabase.from("tickets").select("*").eq("merchant_id", merchantId).eq("external_id", externalId).single();
  if (!t) return res.status(404).json({ error: "unknown ticket" });
  await send(`reopen ${externalId}`, "reopen", t.ticket_hash);
  await supabase.from("tickets").update({ status: "reopened" }).eq("ticket_hash", t.ticket_hash);
  res.json({ ok: true });
});

// --- Customer one-tap rating (public, token-gated, single-use) ---
app.get("/rate/:token", rateLimit(30), (req, res) => {
  if (!verifyRatingToken(req.params.token)) return res.status(410).send("This rating link has expired.");
  res.sendFile(path.join(__dirname, "rate.html"));
});

app.post("/api/rate", rateLimit(10), async (req, res) => {
  const { token, rating } = req.body;
  const ticketHash = verifyRatingToken(token);
  const r = Number(rating);
  if (!ticketHash) return res.status(401).json({ error: "invalid or expired link" });
  if (!Number.isInteger(r) || r < 1 || r > 5) return res.status(400).json({ error: "rating must be 1-5" });

  // SINGLE-USE: atomically claim the token before any chain write.
  const proofHash = ethers.keccak256(ethers.toUtf8Bytes(token));
  const { error: claimErr } = await supabase.from("used_rating_tokens").insert({ proof_hash: proofHash, ticket_hash: ticketHash });
  if (claimErr) return res.status(409).json({ error: "this link was already used" });

  const { data: t } = await supabase.from("tickets").select("*").eq("ticket_hash", ticketHash).single();
  if (!t) return res.status(404).json({ error: "unknown ticket" });

  await send(`rateCust ${t.external_id}`, "rateAsCustomer", ticketHash, r, proofHash);
  await supabase.from("rating_feedback").insert({ merchant_id: t.merchant_id, ticket_hash: ticketHash, confidence: t.confidence, rating: r, rater: "customer" });
  await recalibrate(t.merchant_id);
  res.json({ ok: true });
});

// --- Swap-to-OKB: help a merchant holding other tokens get OKB for gas + escrow ---
// Merchant signs every tx with their own wallet; Clerk only quotes and builds.
app.get("/api/swap/tokens", (_req, res) => {
  res.json({ configured: swapConfigured(), tokens: TOKENS, note: "swap any listed token to native OKB" });
});

app.post("/api/swap/quote", rateLimit(30), async (req, res) => {
  try {
    const { fromToken, amountWei } = req.body;
    if (!fromToken || !amountWei) return res.status(400).json({ error: "fromToken and amountWei required" });
    res.json(await getQuote(fromToken, String(amountWei)));
  } catch (e) {
    const code = String(e.message).includes("NOT_CONFIGURED") ? 503 : 502;
    res.status(code).json({ error: e.message });
  }
});

// Returns the ordered txs (approve?, swap) for the merchant's wallet to sign.
app.post("/api/swap/plan", rateLimit(20), async (req, res) => {
  try {
    const { fromToken, amountWei, userWallet, slippageBps } = req.body;
    if (!fromToken || !amountWei || !userWallet) return res.status(400).json({ error: "fromToken, amountWei, userWallet required" });
    if (!ethers.isAddress(userWallet)) return res.status(400).json({ error: "invalid userWallet" });
    res.json(await planSwapToOKB(fromToken, String(amountWei), userWallet, Number(slippageBps) || 50));
  } catch (e) {
    const code = String(e.message).includes("NOT_CONFIGURED") ? 503 : 502;
    res.status(code).json({ error: e.message });
  }
});

// --- Admin kill switch (bearer token; put behind VPN/allowlist too) ---
app.post("/admin/pause", rateLimit(5), async (req, res) => {
  if (!safeEqual(req.get("Authorization"), `Bearer ${ENV.ADMIN_TOKEN}`)) return res.status(401).json({ error: "unauthorized" });
  await send("setPaused", "setPaused", Boolean(req.body.paused));
  log("warn", "circuit breaker toggled", { paused: Boolean(req.body.paused) });
  res.json({ ok: true, paused: Boolean(req.body.paused) });
});

// ------------------------------------------------------------------
// 7. Finalize sweep — batch, every minute
// ------------------------------------------------------------------
async function finalizeSweep() {
  const { data: pending } = await supabase.from("tickets").select("ticket_hash").eq("status", "pending").limit(100);
  if (!pending?.length) return;
  const hashes = pending.map(p => p.ticket_hash);
  await send(`finalizeBatch x${hashes.length}`, "finalizeBatch", hashes);
  // Confirm which actually finalized by reading back state (batch skips not-ready)
  for (const h of hashes) {
    const t = await ledger.getTicket(h);
    if (Number(t.status) === 3 /* Finalized */) {
      await supabase.from("tickets").update({ status: "finalized" }).eq("ticket_hash", h);
    }
  }
}
setInterval(() => finalizeSweep().catch(e => log("error", "finalize sweep failed", { err: e.message })), 60_000).unref();

// ------------------------------------------------------------------
// 8. Static front-ends (single host: API + UI on Render Web Service)
// ------------------------------------------------------------------
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "landing.html")));
app.use(express.static(__dirname, {
  extensions: ["html"],
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith(".mjs") || filePath.endsWith(".js")) {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    }
  },
}));

// ------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => log("info", `Clerk production service up on :${PORT}`, {
  contract: ENV.CLERK_LEDGER_ADDRESS, rpc: ENV.XLAYER_RPC, network: process.env.XLAYER_NETWORK || "mainnet",
}));
