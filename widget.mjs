/**
 * widget.mjs — embeddable website support + permanent standby learning.
 *
 * Modes (per merchant):
 *   standby — Clerk ALWAYS drafts, ALWAYS learns from human resolutions,
 *             NEVER auto-sends answers to the website visitor.
 *   live    — auto-sends when confidence ≥ threshold; still always learns
 *             when a human finishes the case.
 *
 * Learning contract: every human resolve path calls learnFromHuman() so
 * distilled principles + tone memory grow continuously while Clerk is "on standby".
 */

import crypto from "crypto";
import { ethers } from "ethers";

const scrubPII = (text) => String(text).replace(/\b(?:\d[ -]?){13,19}\b/g, "[card removed]");

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

/** Resolve merchant by public widget key. */
export async function merchantByPublicKey(supabase, publicKey) {
  if (!publicKey) return null;
  const { data, error } = await supabase
    .from("merchants")
    .select("*")
    .eq("widget_public_key", publicKey)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Public config for the dangling bubble (no secrets). */
export function publicWidgetConfig(merchant, baseUrl) {
  return {
    title: merchant.widget_title || "clerk.io support",
    greeting: merchant.widget_greeting || "Hi — I'm clerk.io. How can we help?",
    accent: merchant.widget_accent || "#22F3EE",
    mode: merchant.mode || "standby",
    brand: "clerk.io",
    apiBase: String(baseUrl || "").replace(/\/$/, ""),
  };
}

/** Origin allowlist: empty = allow all (demo); otherwise exact match. */
export function originAllowed(merchant, origin) {
  const list = merchant.widget_allowed_origins || [];
  if (!list.length) return true;
  if (!origin) return false;
  return list.some(o => o === origin || o === "*");
}

/**
 * Start or resume a visitor session on the merchant's site.
 */
export async function openSession(ctx, { publicKey, visitorId, pageUrl, origin }) {
  const merchant = await merchantByPublicKey(ctx.supabase, publicKey);
  if (!merchant) throw Object.assign(new Error("invalid widget key"), { status: 401 });
  if (!originAllowed(merchant, origin)) throw Object.assign(new Error("origin not allowed"), { status: 403 });

  const sessionToken = newToken();
  const externalId = `widget-${sessionToken.slice(0, 12)}`;
  const row = {
    merchant_id: merchant.id,
    session_token: sessionToken,
    visitor_id: visitorId || null,
    page_url: pageUrl || null,
    status: "open",
    external_id: externalId,
  };
  const { data, error } = await ctx.supabase.from("widget_sessions").insert(row).select("*").single();
  if (error) throw error;

  return {
    sessionToken,
    config: publicWidgetConfig(merchant, ctx.publicBaseUrl),
    sessionId: data.id,
  };
}

/**
 * Customer sent a message from the website bubble.
 * Standby: draft only (not shown as final resolution) + queue for human.
 * Live + confident: auto-reply to visitor + optional onchain register.
 */
export async function handleWidgetMessage(ctx, { publicKey, sessionToken, message, origin }) {
  const merchant = await merchantByPublicKey(ctx.supabase, publicKey);
  if (!merchant) throw Object.assign(new Error("invalid widget key"), { status: 401 });
  if (!originAllowed(merchant, origin)) throw Object.assign(new Error("origin not allowed"), { status: 403 });

  const { data: session } = await ctx.supabase
    .from("widget_sessions")
    .select("*")
    .eq("session_token", sessionToken)
    .eq("merchant_id", merchant.id)
    .maybeSingle();
  if (!session) throw Object.assign(new Error("unknown session"), { status: 404 });

  const body = scrubPII(String(message || "").slice(0, 8000));
  if (!body.trim()) throw Object.assign(new Error("empty message"), { status: 400 });

  const externalId = session.external_id || `widget-${session.id}`;
  let ticketHash = session.ticket_hash;
  if (!ticketHash) {
    ticketHash = ethers.keccak256(
      ethers.toUtf8Bytes(`${merchant.id}:${externalId}:${body}`)
    );
    // First message: open ticket offchain; onchain when merchant has wallet + live mode
    try {
      if (merchant.wallet_address && merchant.mode === "live" && ctx.send) {
        await ctx.send(`registerTicket ${externalId}`, "registerTicket", ticketHash, merchant.wallet_address);
      }
    } catch (e) {
      ctx.log?.("warn", "widget chain register skipped", { err: e.message });
    }
    await ctx.supabase.from("tickets").upsert({
      merchant_id: merchant.id,
      external_id: externalId,
      ticket_hash: ticketHash,
      status: "new",
      turn_count: 1,
    }, { onConflict: "ticket_hash" });
    await ctx.supabase.from("widget_sessions").update({
      ticket_hash: ticketHash,
      external_id: externalId,
      updated_at: new Date(),
    }).eq("id", session.id);
  }

  await ctx.supabase.from("ticket_messages").insert({
    merchant_id: merchant.id,
    ticket_hash: ticketHash,
    role: "customer",
    body,
    intent: "question",
  });

  // --- Always draft (standby nature: never idle) ---
  let chunks = [];
  let tone = null;
  let principles = [];
  try {
    const emb = await ctx.embed(body);
    const { data: ch } = await ctx.supabase.rpc("match_chunks", {
      p_merchant: merchant.id, query_embedding: emb, match_count: 5,
    });
    chunks = ch || [];
  } catch (e) {
    ctx.log?.("warn", "widget embed/match failed", { err: e.message });
  }
  try {
    const { data: tp } = await ctx.supabase.from("tone_profiles").select("profile").eq("merchant_id", merchant.id).maybeSingle();
    tone = tp?.profile;
    const { data: pr } = await ctx.supabase.from("reply_principles")
      .select("principle").eq("merchant_id", merchant.id)
      .order("created_at", { ascending: false }).limit(5);
    principles = pr || [];
  } catch { /* memory optional */ }

  const result = await ctx.draftWithConfidence(body, chunks, tone, principles);
  const { data: cal } = await ctx.supabase.from("calibration_state")
    .select("auto_send_threshold").eq("merchant_id", merchant.id).maybeSingle();
  const threshold = Number(cal?.auto_send_threshold ?? 80);
  const mode = merchant.mode || "standby";
  const confident = result && result.confidence >= threshold;
  const autoSend = mode === "live" && confident;

  // Always store shadow draft (learning fuel even if not shown)
  if (result) {
    await ctx.supabase.from("shadow_drafts").insert({
      merchant_id: merchant.id,
      session_id: session.id,
      ticket_hash: ticketHash,
      customer_message: body,
      clerk_draft: result.draft,
      confidence: result.confidence,
      source_used: result.sourceUsed,
      shown_to_customer: Boolean(autoSend),
    });
  }

  if (autoSend) {
    await ctx.supabase.from("ticket_messages").insert({
      merchant_id: merchant.id,
      ticket_hash: ticketHash,
      role: "clerk",
      body: result.draft,
      confidence: result.confidence,
      source_used: result.sourceUsed,
    });
    try {
      if (merchant.wallet_address && ctx.send) {
        await ctx.send(
          `submitResolution ${externalId}`,
          "submitResolution",
          ticketHash,
          Math.round(result.confidence * 100),
          true
        );
      }
    } catch (e) {
      ctx.log?.("warn", "widget chain submit skipped", { err: e.message });
    }
    await ctx.supabase.from("tickets").update({
      status: "pending",
      confidence: result.confidence,
      resolved_by_clerk: true,
      source_used: result.sourceUsed,
    }).eq("ticket_hash", ticketHash);
    await ctx.supabase.from("widget_sessions").update({
      status: "resolved_by_clerk",
      updated_at: new Date(),
    }).eq("id", session.id);

    return {
      action: "auto_reply",
      mode,
      confidence: result.confidence,
      reply: result.draft,
      messages: [
        { role: "clerk", body: result.draft },
      ],
    };
  }

  // Standby OR low confidence → hand to human, Clerk stays learning
  const handoff =
    mode === "standby"
      ? "Thanks — I'm routing this to the team (clerk.io is learning from every resolution). A human will take it from here."
      : "I want to make sure this is right — connecting you with a team member who can help.";

  await ctx.supabase.from("ticket_messages").insert({
    merchant_id: merchant.id,
    ticket_hash: ticketHash,
    role: "clerk",
    body: handoff,
    confidence: result?.confidence ?? 0,
    source_used: result?.sourceUsed ?? "none",
  });
  await ctx.supabase.from("tickets").update({
    status: "escalated",
    confidence: result?.confidence ?? 0,
    source_used: result?.sourceUsed ?? "none",
    awaiting: "human",
  }).eq("ticket_hash", ticketHash);
  await ctx.supabase.from("widget_sessions").update({
    status: "awaiting_human",
    updated_at: new Date(),
  }).eq("id", session.id);
  await ctx.supabase.from("widget_queue").insert({
    merchant_id: merchant.id,
    session_id: session.id,
    clerk_draft: result?.draft ?? null,
    confidence: result?.confidence ?? null,
    status: "open",
  });

  // Notify internal adapters (merchant ticket system)
  try {
    await ctx.assignToHuman?.(
      merchant,
      externalId,
      result?.draft ?? "(no draft)",
      result?.confidence ?? 0,
      result?.sourceUsed ?? "none"
    );
  } catch { /* optional */ }

  return {
    action: "awaiting_human",
    mode,
    confidence: result?.confidence ?? 0,
    reply: handoff,
    // Internal draft is NOT shown as the customer-facing answer in standby
    clerkDraftForDesk: result?.draft ?? null,
    messages: [{ role: "clerk", body: handoff }],
  };
}

/**
 * Distill one resolved exchange into a generalized reply-writing PRINCIPLE —
 * the reasoning/policy behind the reply, never the reply's own wording. This
 * is what keeps Clerk from parroting identical phrasing to different
 * customers: draftWithConfidence() is fed principles, not literal replies.
 * Fails open (never blocks a resolution on an LLM hiccup).
 */
async function distillPrinciple(llmFn, { customerMessage, humanReply, priorDraft }) {
  if (!llmFn) return null;
  const prompt =
`You are extracting a general reply-writing PRINCIPLE from one resolved customer support exchange. Do NOT extract or restate the literal wording. Do NOT produce reusable customer-facing phrasing. Extract only the underlying reasoning, policy, or decision logic a support agent used, in a way that generalizes to differently-worded future questions on the same topic.

Customer said: ${customerMessage}
${priorDraft ? `Clerk's draft attempt: ${priorDraft}\n` : ""}Correct/human reply: ${humanReply}

Output ONLY one or two sentences describing the principle/logic (e.g. "Refunds for damaged items are approved without requiring photo proof if the order is under 30 days old" — not "Reply: Sorry to hear that! We'll refund you right away."). Do not include greetings, sign-offs, or customer-facing phrasing. If no generalizable principle can be extracted, output exactly: NONE`;
  try {
    const out = String(await llmFn(prompt, 15_000) ?? "").trim();
    if (!out || out.toUpperCase() === "NONE") return null;
    return out;
  } catch {
    return null; // fail-open — distillation is best-effort, never blocks a resolution
  }
}

/**
 * Human finished a case — THE learning path. Always on, standby or live.
 * Stores a distilled principle (not verbatim reply text), learning_event,
 * optionally refreshes tone.
 */
export async function learnFromHuman(ctx, {
  merchantId,
  customerMessage,
  humanReply,
  ticketHash = null,
  sessionId = null,
  clerkDraft = null,
  clerkConfidence = null,
  source = "human_resolve",
  category = "_widget",
}) {
  const cust = scrubPII(String(customerMessage || "").trim());
  const hum = scrubPII(String(humanReply || "").trim());
  if (!merchantId || !cust || !hum) throw Object.assign(new Error("merchantId, customerMessage, humanReply required"), { status: 400 });

  // 1) Distill the logic behind this reply — not the reply's own wording — so
  // future drafts apply the same reasoning in fresh phrasing each time.
  const principle = await distillPrinciple(ctx.llm, { customerMessage: cust, humanReply: hum, priorDraft: clerkDraft });
  if (principle) {
    await ctx.supabase.from("reply_principles").insert({
      merchant_id: merchantId,
      category,
      principle: scrubPII(principle),
      source_ticket_hash: ticketHash,
    });
  }

  // 2) Learning event audit trail
  await ctx.supabase.from("learning_events").insert({
    merchant_id: merchantId,
    ticket_hash: ticketHash,
    session_id: sessionId,
    customer_message: cust,
    human_reply: hum,
    clerk_draft: clerkDraft,
    clerk_confidence: clerkConfidence,
    source,
  });

  // 3) Bump tone profile observation count; optional LLM distill later
  const { data: tone } = await ctx.supabase.from("tone_profiles")
    .select("*").eq("merchant_id", merchantId).maybeSingle();
  if (tone) {
    await ctx.supabase.from("tone_profiles").update({
      tickets_observed: (tone.tickets_observed || 0) + 1,
      updated_at: new Date(),
    }).eq("merchant_id", merchantId);
  } else {
    await ctx.supabase.from("tone_profiles").insert({
      merchant_id: merchantId,
      profile: "professional, warm, concise — learned from human support replies",
      tickets_observed: 1,
    });
  }

  // 4) Close session / queue if present
  if (sessionId) {
    await ctx.supabase.from("widget_sessions").update({
      status: "resolved_by_human",
      updated_at: new Date(),
    }).eq("id", sessionId);
    await ctx.supabase.from("widget_queue").update({ status: "done" })
      .eq("session_id", sessionId).eq("status", "open");
  }
  if (ticketHash) {
    await ctx.supabase.from("tickets").update({
      status: "pending",
      resolved_by_clerk: false,
      awaiting: null,
    }).eq("ticket_hash", ticketHash);
    await ctx.supabase.from("ticket_messages").insert({
      merchant_id: merchantId,
      ticket_hash: ticketHash,
      role: "human",
      body: hum,
    });
  }

  ctx.log?.("info", "learned from human", { merchantId, source });
  return { ok: true, learned: true };
}

/** Admin: create embed key for a merchant (or register merchant + key). */
export async function provisionWidget(ctx, {
  merchantId,
  name,
  walletAddress,
  mode = "standby",
  allowedOrigins = [],
  greeting,
  title,
  accent,
}) {
  let mid = merchantId;
  if (!mid) {
    if (!name || !walletAddress) throw Object.assign(new Error("name and walletAddress required for new merchant"), { status: 400 });
    const { data, error } = await ctx.supabase.from("merchants").insert({
      name,
      wallet_address: walletAddress,
      ticket_system: "widget",
      mode: mode === "live" ? "live" : "standby",
      widget_public_key: `pk_live_${crypto.randomBytes(16).toString("hex")}`,
      widget_allowed_origins: allowedOrigins,
      widget_greeting: greeting || undefined,
      widget_title: title || undefined,
      widget_accent: accent || undefined,
    }).select("*").single();
    if (error) throw error;
    await ctx.supabase.from("calibration_state").upsert({
      merchant_id: data.id,
      auto_send_threshold: 80,
    });
    return {
      merchantId: data.id,
      publicKey: data.widget_public_key,
      mode: data.mode,
      installSnippet: installSnippet(ctx.publicBaseUrl, data.widget_public_key),
    };
  }

  const publicKey = `pk_live_${crypto.randomBytes(16).toString("hex")}`;
  const patch = {
    widget_public_key: publicKey,
    mode: mode === "live" ? "live" : "standby",
  };
  if (allowedOrigins?.length) patch.widget_allowed_origins = allowedOrigins;
  if (greeting) patch.widget_greeting = greeting;
  if (title) patch.widget_title = title;
  if (accent) patch.widget_accent = accent;

  const { data, error } = await ctx.supabase.from("merchants")
    .update(patch).eq("id", mid).select("*").single();
  if (error) throw error;
  return {
    merchantId: data.id,
    publicKey: data.widget_public_key,
    mode: data.mode,
    installSnippet: installSnippet(ctx.publicBaseUrl, data.widget_public_key),
  };
}

export function installSnippet(baseUrl, publicKey) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  return `<!-- clerk.io embed — paste before </body> -->
<script
  src="${base}/widget/v1.js"
  data-clerk-key="${publicKey}"
  data-clerk-base="${base}"
  async
></script>`;
}
