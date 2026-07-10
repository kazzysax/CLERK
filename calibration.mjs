/**
 * calibration.js — makes Clerk's confidence smarter over time, per merchant.
 *
 * Upgrades over the single global threshold in server.js:
 *  1. PER-CATEGORY thresholds — Clerk may deserve 95% trust on "shipping" and
 *     60% on "refunds" at the same merchant. One bar per category, not per shop.
 *  2. CALIBRATION MEASUREMENT — is Clerk's "90% confident" actually right ~90%
 *     of the time? Computed from stored rating feedback (rating>=4 = "was right").
 *     If Clerk is overconfident in a category, its bar rises automatically.
 *  3. DUPLICATE / PATTERN DETECTION — many tickets on the same root cause this
 *     week get flagged so the merchant fixes the cause, and Clerk batch-answers
 *     the rest at higher confidence.
 *  4. ESCALATION-NOTE QUALITY — did the human resolve faster when Clerk's note
 *     was attached? Tracks note usefulness so it's a measured signal, not a hope.
 *
 * All state is per-merchant and RLS-fenced. Nothing here touches the chain.
 */

/** Category-aware auto-send threshold. Falls back to the global one. */
export async function thresholdFor(supabase, merchantId, category) {
  const { data } = await supabase.from("category_calibration")
    .select("auto_send_threshold").eq("merchant_id", merchantId).eq("category", category ?? "_default").maybeSingle();
  if (data) return Number(data.auto_send_threshold);
  const { data: g } = await supabase.from("calibration_state")
    .select("auto_send_threshold").eq("merchant_id", merchantId).maybeSingle();
  return Number(g?.auto_send_threshold ?? 80);
}

/**
 * Recalibrate one category from its recent rating feedback.
 *  - 2+ weak ratings (<=3) on confident sends → raise bar (Clerk overconfident here)
 *  - 15+ strong ratings (5) and no weak → ease bar slightly (Clerk underusing itself)
 *  - Also computes a calibration gap: mean(confidence) vs realized success rate.
 */
export async function recalibrateCategory(supabase, merchantId, category) {
  const cat = category ?? "_default";
  const { data: fb } = await supabase.from("rating_feedback")
    .select("confidence, rating, category")
    .eq("merchant_id", merchantId).eq("rater", "customer").eq("category", cat)
    .order("created_at", { ascending: false }).limit(30);
  if (!fb?.length) return null;

  let threshold = await thresholdFor(supabase, merchantId, cat);
  const weakConfident = fb.filter(r => r.rating <= 3 && r.confidence >= threshold);
  const strong = fb.filter(r => r.rating === 5);

  // Calibration gap: claimed confidence vs realized "was right" rate.
  const meanConf = fb.reduce((a, r) => a + Number(r.confidence), 0) / fb.length; // 0-100
  const successRate = fb.filter(r => r.rating >= 4).length / fb.length * 100;
  const gap = meanConf - successRate; // positive = overconfident

  if (weakConfident.length >= 2 || gap > 12) threshold = Math.min(95, threshold + 3);
  else if (strong.length >= 15 && gap < 4) threshold = Math.max(70, threshold - 1);

  await supabase.from("category_calibration").upsert({
    merchant_id: merchantId, category: cat, auto_send_threshold: threshold,
    mean_confidence: meanConf, success_rate: successRate, calibration_gap: gap,
    samples: fb.length, updated_at: new Date(),
  });
  return { category: cat, threshold, meanConf, successRate, gap };
}

/**
 * Duplicate / pattern detection. Looks for other recent OPEN or recently-created
 * tickets at this merchant whose embedding is very close to this one.
 * Returns { isDuplicate, count, exemplarHash } — the caller can boost confidence
 * and surface "Nth ticket about X this week" to the merchant.
 */
export async function detectPattern(supabase, merchantId, embedding, sinceHours = 168) {
  const { data } = await supabase.rpc("match_recent_tickets", {
    p_merchant: merchantId, query_embedding: embedding,
    since_hours: sinceHours, similarity_floor: 0.9,
  });
  if (!data || data.length < 2) return { isDuplicate: false, count: data?.length ?? 0 };
  return { isDuplicate: true, count: data.length, exemplarHash: data[0].ticket_hash };
}

/**
 * Escalation-note quality. Call when a human closes an escalated ticket.
 * Records whether the human's resolution came quickly after the handoff
 * (a proxy for "the note helped") so note usefulness becomes measurable.
 */
export async function recordEscalationOutcome(supabase, merchantId, ticketHash, hadNote, minutesToResolve) {
  await supabase.from("escalation_outcomes").insert({
    merchant_id: merchantId, ticket_hash: ticketHash,
    had_note: hadNote, minutes_to_resolve: minutesToResolve,
  });
}

/** Report: average time-to-resolve with vs without Clerk's note. */
export async function noteEffectiveness(supabase, merchantId) {
  const { data } = await supabase.from("escalation_outcomes")
    .select("had_note, minutes_to_resolve").eq("merchant_id", merchantId);
  if (!data?.length) return null;
  const withNote = data.filter(d => d.had_note).map(d => d.minutes_to_resolve);
  const without = data.filter(d => !d.had_note).map(d => d.minutes_to_resolve);
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  return { withNoteMin: mean(withNote), withoutNoteMin: mean(without), samples: data.length };
}
