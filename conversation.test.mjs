/**
 * conversation.test.mjs — verifies the multi-turn router does the right thing
 * for each customer intent, using in-memory mocks for Supabase, the contract,
 * and the LLM. Run: node conversation.test.mjs
 *
 * The load-bearing assertion: a "complaint" on a Pending ticket calls
 * reopen() onchain — Clerk voiding its own payout when the customer says it
 * wasn't solved.
 */
import { handleReply, classifyReply, threadToContext } from "./conversation.mjs";
import assert from "assert";

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; console.log("PASS -", name); } else { failed++; console.log("FAIL -", name); } };

// --- Mock factory: a ctx with a ticket in a given status, recording chain calls ---
function makeCtx(ticket, intent) {
  const chainCalls = [];
  const updates = [];
  const supabase = {
    from(table) {
      const api = {
        _table: table, _filters: {},
        select() { return api; },
        eq(k, v) { api._filters[k] = v; return api; },
        maybeSingle: async () => ({ data: table === "calibration_state" ? { auto_send_threshold: 80 } : (table === "tone_profiles" ? { profile: "warm" } : null) }),
        single: async () => ({ data: table === "tickets" ? ticket : table === "merchants" ? { id: "m1", wallet_address: "0xMERCH" } : null }),
        insert: async () => ({ error: null }),
        order() { return api; }, limit() { return api; },
      };
      // make update().eq() resolve
      api.update = (vals) => { updates.push({ table, vals }); const chain = { eq: () => chain, order: () => chain, limit: async () => ({}) }; return chain; };
      return api;
    },
    rpc: async (fn) => ({ data: fn === "thread_history" ? [{ role: "customer", body: "hi" }] : [{ content: "kb chunk", document_id: "d" }] }),
  };
  const ctx = {
    supabase,
    ledger: {},
    send: async (label, method) => { chainCalls.push(method); },
    embed: async () => new Array(384).fill(0),
    llm: async () => JSON.stringify({ intent, reason: "test" }),
    draftWithConfidence: async () => ({ draft: "here you go", confidence: 95, sourceUsed: "[1]" }),
    recalibrate: async () => {},
    sendReplyToTicketSystem: async () => {},
    assignToHuman: async () => {},
  };
  return { ctx, chainCalls, updates };
}

(async () => {
  // threadToContext
  ok("threadToContext labels roles",
    threadToContext([{ role: "customer", body: "a" }, { role: "clerk", body: "b" }]) === "Customer: a\nClerk: b");

  // classifyReply falls back to 'other' on bad LLM output
  const badLlm = async () => "not json";
  ok("classifyReply fails safe to 'other'", (await classifyReply(badLlm, "", "??", true)) === "other");

  // COMPLAINT on pending → auto-reopen onchain
  {
    const { ctx, chainCalls } = makeCtx({ ticket_hash: "0xT", status: "pending", confidence: 90, turn_count: 1 }, "complaint");
    const out = await handleReply(ctx, "m1", "T-1", "this did NOT fix it");
    ok("complaint on pending → action auto_reopened", out.action === "auto_reopened");
    ok("complaint on pending → reopen() called onchain", chainCalls.includes("reopen"));
  }

  // COMPLAINT on finalized → escalate, no reopen (window passed)
  {
    const { ctx, chainCalls } = makeCtx({ ticket_hash: "0xT", status: "finalized", confidence: 90, turn_count: 1 }, "complaint");
    const out = await handleReply(ctx, "m1", "T-1", "still broken");
    ok("complaint on finalized → escalated_post_window", out.action === "escalated_post_window");
    ok("complaint on finalized → NO reopen call", !chainCalls.includes("reopen"));
  }

  // THANKS → acknowledged, no chain write
  {
    const { ctx, chainCalls } = makeCtx({ ticket_hash: "0xT", status: "pending", confidence: 90, turn_count: 1 }, "thanks");
    const out = await handleReply(ctx, "m1", "T-1", "thank you!!");
    ok("thanks → acknowledged", out.action === "acknowledged");
    ok("thanks → no chain write", chainCalls.length === 0);
  }

  // QUESTION on an open (escalated) ticket, high confidence → answered + submitResolution
  {
    const { ctx, chainCalls } = makeCtx({ ticket_hash: "0xT", status: "escalated", confidence: null, turn_count: 1 }, "question");
    const out = await handleReply(ctx, "m1", "T-1", "do you ship to Canada?");
    ok("question on open ticket → answered", out.action === "answered");
    ok("question resolving turn → submitResolution called", chainCalls.includes("submitResolution"));
  }

  // FOLLOWUP on a pending ticket → answered, no NEW submitResolution (already pending)
  {
    const { ctx, chainCalls } = makeCtx({ ticket_hash: "0xT", status: "pending", confidence: 95, turn_count: 2 }, "followup");
    const out = await handleReply(ctx, "m1", "T-1", "and how long does it take?");
    ok("followup on pending → answered", out.action === "answered");
    ok("followup on pending → no duplicate submitResolution", !chainCalls.includes("submitResolution"));
  }

  // OTHER → escalate
  {
    const { ctx } = makeCtx({ ticket_hash: "0xT", status: "pending", confidence: 90, turn_count: 1 }, "other");
    const out = await handleReply(ctx, "m1", "T-1", "asdkjfh");
    ok("other → escalated", out.action === "escalated");
  }

  console.log(`\n${passed} passing, ${failed} failing`);
  process.exit(failed ? 1 : 0);
})();
