/**
 * conversation.js — multi-turn thread handling for Clerk.
 *
 * The gap this closes: a support ticket is a CONVERSATION, not a single
 * message. A customer replies "that link is broken" or "thanks!" or "actually
 * can you also change my address?" — and Clerk must understand which of those
 * it's looking at and act differently for each.
 *
 * Turn taxonomy (what a customer reply can be):
 *   - question   : a fresh question within the ticket        → draft & maybe resolve
 *   - followup   : builds on the prior answer, needs more    → draft with context
 *   - thanks     : closure signal                            → confirm, no re-lock
 *   - complaint  : "this didn't fix it" AFTER a resolution   → AUTO-REOPEN onchain
 *   - other      : anything else                             → escalate to human
 *
 * The pivotal one is `complaint` on an already-resolved ticket: the customer
 * saying "this didn't work" is exactly the signal your escrow reopen window
 * exists for. Clerk voids its own pending payout — no button, no dispute
 * process — the moment the served customer says it wasn't solved.
 *
 * Every clerk turn is grounded in the SAME per-merchant memory (RLS-fenced)
 * and the SAME confidence→route logic as a first turn; multi-turn changes the
 * CONTEXT fed to the model and what a customer reply is allowed to trigger,
 * not the core resolve-or-escalate contract.
 */

import { ethers } from "ethers";

/**
 * Classify a customer reply in the context of the thread so far.
 * Returns one of the five intents. Cheap, strict, and defaults to the safe
 * choice (escalate) on any ambiguity or model failure.
 */
export async function classifyReply(llm, threadText, replyText, ticketWasResolved) {
  const prompt =
`You are triaging one new customer message inside an ongoing support thread.
THREAD SO FAR:
${threadText || "(this is the first message)"}

NEW CUSTOMER MESSAGE:
${replyText}

The ticket ${ticketWasResolved ? "WAS marked resolved by support" : "is still open"}.
Classify the NEW message as exactly one of:
- "question": a new question that can be answered
- "followup": needs more info or continues the prior answer
- "thanks": the customer is satisfied / closing out
- "complaint": the customer says the problem is NOT solved or is unhappy with the resolution
- "other": off-topic, unclear, or needs a human

Respond ONLY with JSON: {"intent":"...","reason":"one short clause"}`;
  try {
    const raw = await llm(prompt, 15_000);
    const parsed = JSON.parse(String(raw).replace(/```json|```/g, "").trim());
    const allowed = ["question", "followup", "thanks", "complaint", "other"];
    return allowed.includes(parsed.intent) ? parsed.intent : "other";
  } catch {
    return "other"; // fail safe → human
  }
}

/**
 * Assemble the thread into the prompt context for a follow-up draft. Keeps the
 * last N turns to bound token cost; the knowledge base still supplies facts.
 */
export function threadToContext(messages, maxTurns = 8) {
  const recent = messages.slice(-maxTurns);
  return recent.map(m => {
    const who = m.role === "clerk" ? "Clerk" : m.role === "human" ? "Agent" : "Customer";
    return `${who}: ${m.body}`;
  }).join("\n");
}

/**
 * Handle a customer reply on an EXISTING ticket. This is the multi-turn
 * entry point, called by the /webhooks/ticket-reply route.
 *
 * deps injected so this module stays pure/testable:
 *   ctx = { supabase, ledger, send, embed, draftWithConfidence, llm,
 *           recalibrate, sendReplyToTicketSystem, assignToHuman }
 */
export async function handleReply(ctx, merchantId, externalId, replyText) {
  const { supabase, send, embed, draftWithConfidence, llm } = ctx;

  const { data: ticket } = await supabase.from("tickets").select("*")
    .eq("merchant_id", merchantId).eq("external_id", externalId).single();
  if (!ticket) throw new Error("reply to unknown ticket");

  const ticketHash = ticket.ticket_hash;
  const wasResolved = ["pending", "finalized"].includes(ticket.status);

  // Record the customer's message.
  await supabase.from("ticket_messages").insert({
    merchant_id: merchantId, ticket_hash: ticketHash, role: "customer", body: replyText,
  });
  const { data: history } = await supabase.rpc("thread_history", { p_ticket: ticketHash });
  const threadText = threadToContext(history ?? []);

  // Classify what this reply IS.
  const intent = await classifyReply(llm, threadText, replyText, wasResolved);
  await supabase.from("ticket_messages").update({ intent })
    .eq("ticket_hash", ticketHash).eq("role", "customer").order("created_at", { ascending: false }).limit(1);
  await supabase.from("tickets").update({
    turn_count: (ticket.turn_count ?? 0) + 1, last_customer_intent: intent,
  }).eq("ticket_hash", ticketHash);

  // ---- Route by intent ----

  // COMPLAINT on a resolved ticket → auto-reopen. Clerk voids its own payout.
  if (intent === "complaint" && ticket.status === "pending") {
    await send(`auto-reopen ${externalId}`, "reopen", ticketHash);
    await supabase.from("tickets").update({ status: "reopened", awaiting: "human" }).eq("ticket_hash", ticketHash);
    await ctx.assignToHuman(await merchantRow(ctx, merchantId), externalId,
      "Customer says the resolution didn't work. Clerk auto-reopened (payout voided). Please take over.", ticket.confidence, ticket.source_used);
    return { action: "auto_reopened", intent };
  }
  // Complaint on an already-finalized ticket (window passed) → can't reopen
  // onchain, but must still get a human. No silent drop.
  if (intent === "complaint") {
    await supabase.from("tickets").update({ awaiting: "human" }).eq("ticket_hash", ticketHash);
    await ctx.assignToHuman(await merchantRow(ctx, merchantId), externalId,
      "Customer unhappy after the reopen window closed — needs a human follow-up.", ticket.confidence, ticket.source_used);
    return { action: "escalated_post_window", intent };
  }

  // THANKS → acknowledge, leave the resolution to finalize normally.
  if (intent === "thanks") {
    const msg = "You're welcome — glad that helped! Reach out anytime.";
    await ctx.sendReplyToTicketSystem(await merchantRow(ctx, merchantId), externalId, msg);
    await supabase.from("ticket_messages").insert({ merchant_id: merchantId, ticket_hash: ticketHash, role: "clerk", body: msg });
    await supabase.from("tickets").update({ awaiting: null }).eq("ticket_hash", ticketHash);
    return { action: "acknowledged", intent };
  }

  // OTHER → hand to a human, no guessing.
  if (intent === "other") {
    await supabase.from("tickets").update({ awaiting: "human" }).eq("ticket_hash", ticketHash);
    await ctx.assignToHuman(await merchantRow(ctx, merchantId), externalId, "Ambiguous customer reply — needs a human.", ticket.confidence, ticket.source_used);
    return { action: "escalated", intent };
  }

  // QUESTION or FOLLOWUP → draft again, WITH thread context, same confidence gate.
  const qEmbedding = await embed(replyText);
  const { data: chunks } = await supabase.rpc("match_chunks", { p_merchant: merchantId, query_embedding: qEmbedding, match_count: 5 });
  const { data: tonep } = await supabase.from("tone_profiles").select("profile").eq("merchant_id", merchantId).maybeSingle();

  // Feed the running thread as "exemplars" context slot so the draft is coherent with what was already said.
  const result = await draftWithConfidence(
    `${threadText}\n\nLatest customer message to answer: ${replyText}`,
    chunks ?? [], tonep?.profile, []
  );
  const { data: cal } = await supabase.from("calibration_state").select("auto_send_threshold").eq("merchant_id", merchantId).maybeSingle();
  const threshold = Number(cal?.auto_send_threshold ?? 80);
  const merchant = await merchantRow(ctx, merchantId);

  if (result && result.confidence >= threshold) {
    await ctx.sendReplyToTicketSystem(merchant, externalId, result.draft);
    await supabase.from("ticket_messages").insert({
      merchant_id: merchantId, ticket_hash: ticketHash, role: "clerk", body: result.draft,
      confidence: result.confidence, source_used: result.sourceUsed,
    });
    // If the ticket was Registered (never resolved), this may be the resolving turn.
    if (ticket.status === "new" || ticket.status === "escalated") {
      await send(`submitResolution ${externalId}`, "submitResolution", ticketHash, Math.round(result.confidence * 100), true);
      await supabase.from("tickets").update({ status: "pending", resolved_by_clerk: true, confidence: result.confidence, awaiting: "customer" }).eq("ticket_hash", ticketHash);
    } else {
      await supabase.from("tickets").update({ awaiting: "customer" }).eq("ticket_hash", ticketHash);
    }
    return { action: "answered", intent, confidence: result.confidence };
  }

  // Low confidence / failure → escalate with the running thread as context.
  await ctx.assignToHuman(merchant, externalId, result?.draft ?? "(pipeline failure)", result?.confidence ?? 0, result?.sourceUsed ?? "none");
  await supabase.from("tickets").update({ status: "escalated", awaiting: "human" }).eq("ticket_hash", ticketHash);
  return { action: "escalated", intent, confidence: result?.confidence ?? 0 };
}

async function merchantRow(ctx, merchantId) {
  const { data } = await ctx.supabase.from("merchants").select("*").eq("id", merchantId).single();
  return data;
}
