// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

// Internal-only: called by server.mjs's embed() with the service-role key.
// gte-small is Supabase's built-in edge-runtime embedding model — 384 dims,
// matching doc_chunks.embedding vector(384) in supabase/schema.sql.
const model = new Supabase.ai.Session("gte-small");

export default {
  fetch: withSupabase({ auth: ["secret"] }, async (req) => {
    let text: unknown;
    try {
      ({ text } = await req.json());
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }
    if (typeof text !== "string" || !text.trim()) {
      return Response.json({ error: "text (non-empty string) required" }, { status: 400 });
    }
    try {
      const embedding = await model.run(text, { mean_pool: true, normalize: true });
      return Response.json({ embedding });
    } catch (err) {
      return Response.json({ error: String((err as Error)?.message ?? err) }, { status: 500 });
    }
  }),
};

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/embed' \
    --header 'apiKey: <secret key>' \
    --data '{"text":"Do you ship to Canada?"}'

*/
