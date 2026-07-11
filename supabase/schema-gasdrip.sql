-- ============================================================
-- schema-gasdrip.sql — Clerk-sponsored gas for merchant wallets.
-- Run AFTER schema-production.sql in the Supabase SQL editor.
--
-- One lifetime drip per wallet address: the primary key on `address`
-- IS the single-use enforcement, same pattern as used_rating_tokens.
-- server.mjs inserts a 'pending' row before sending; a second request
-- for the same address fails the insert atomically (409 to the user).
-- ============================================================

create table gas_drips (
  address text primary key,             -- lowercased wallet address
  status text not null default 'pending', -- pending | sent | failed
  amount_wei text,
  tx_hash text,
  requested_at timestamptz not null default now(),
  sent_at timestamptz
);

alter table gas_drips enable row level security;
-- No policies: service-role only. Merchants and anon keys can never touch it.
