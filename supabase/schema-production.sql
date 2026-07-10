-- ============================================================
-- schema-production.sql — additions to schema.sql for launch.
-- Run AFTER schema.sql in the Supabase SQL editor.
-- ============================================================

-- Single-use rating tokens: the unique constraint IS the single-use
-- enforcement. server.js inserts before any chain write; a second
-- insert with the same proof_hash fails atomically (409 to the user).
create table used_rating_tokens (
  proof_hash text primary key,          -- keccak256(token), also emitted onchain
  ticket_hash text not null,
  used_at timestamptz not null default now()
);
-- One rating per ticket regardless of token reissue:
create unique index used_tokens_ticket on used_rating_tokens (ticket_hash);

alter table used_rating_tokens enable row level security;
-- No policies: service-role only. Merchants and anon keys can never touch it.

-- Ops visibility: reopen-rate per merchant over the last 7 days.
-- Alert if > 15% — either Clerk is misfiring or someone is probing.
create or replace view ops_reopen_rate as
select
  merchant_id,
  count(*) filter (where status = 'reopened') as reopened,
  count(*) filter (where status in ('finalized','reopened','pending')) as total,
  round(
    100.0 * count(*) filter (where status = 'reopened')
    / greatest(count(*) filter (where status in ('finalized','reopened','pending')), 1)
  , 1) as reopen_pct
from tickets
where created_at > now() - interval '7 days'
group by merchant_id;
