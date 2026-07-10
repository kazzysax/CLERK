/**
 * apply-schema.mjs — run Clerk SQL against Supabase.
 *
 * Preferred: set DATABASE_URL (Supabase → Project Settings → Database → URI)
 * then: node scripts/apply-schema.mjs
 *
 * Without DATABASE_URL this prints the ordered SQL files to paste in the
 * Supabase SQL Editor (Dashboard → SQL → New query).
 */
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const files = [
  "supabase/schema.sql",
  "supabase/schema-production.sql",
  "supabase/schema-conversations.sql",
  "supabase/schema-calibration.sql",
];

const sql = files.map(f => {
  const p = path.join(root, f);
  return `-- ========== ${f} ==========\n` + readFileSync(p, "utf8");
}).join("\n\n");

const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.log("No DATABASE_URL set. Open Supabase → SQL Editor and paste the combined SQL.\n");
  console.log("Writing combined file: supabase/ALL.sql");
  const out = path.join(root, "supabase", "ALL.sql");
  const { writeFileSync } = await import("fs");
  writeFileSync(out, sql);
  console.log(`Wrote ${out} (${sql.length} chars). Paste into SQL Editor → Run.`);
  process.exit(0);
}

// Dynamic import so local boot works without pg until DATABASE_URL is set.
const { default: pg } = await import("pg").catch(() => ({ default: null }));
if (!pg) {
  console.error("Install pg: npm i pg");
  process.exit(1);
}
const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();
console.log("Connected. Applying schemas…");
await client.query(sql);
console.log("OK — all schema files applied.");
await client.end();
