-- ========== supabase/schema.sql ==========
-- ============================================================
-- Clerk memory layer — Supabase (Postgres + pgvector)
-- One project, many merchants. Isolation enforced by RLS,
-- not by application code remembering a WHERE clause.
--
-- Run in the Supabase SQL editor (Dashboard → SQL) in order.
-- ============================================================

create extension if not exists vector;

-- ------------------------------------------------------------
-- 1. Tenants
-- ------------------------------------------------------------
create table merchants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  wallet_address text not null unique,   -- links to ClerkLedger merchant onchain
  ticket_system text not null default 'demo', -- zendesk | intercom | demo
  created_at timestamptz not null default now()
);

-- Each merchant's dashboard user authenticates via Supabase Auth.
-- Their JWT carries merchant_id as a custom claim (set on signup, see wiring doc).
-- Helper to read it inside policies:
create or replace function auth_merchant_id() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'merchant_id','')::uuid
$$;

-- ------------------------------------------------------------
-- 2. Store #1 — knowledge base (docs → chunks → embeddings)
-- ------------------------------------------------------------
create table documents (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  title text not null,
  storage_path text not null,            -- Supabase Storage: {merchant_id}/{filename}
  kind text not null default 'faq',      -- faq | policy | past_tickets | product
  created_at timestamptz not null default now()
);

create table doc_chunks (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  content text not null,
  embedding vector(384) not null,        -- gte-small (Supabase built-in embeddings)
  created_at timestamptz not null default now()
);

-- HNSW index for fast similarity search at any scale
create index doc_chunks_embedding_idx on doc_chunks
  using hnsw (embedding vector_cosine_ops);
create index doc_chunks_merchant_idx on doc_chunks (merchant_id);

-- ------------------------------------------------------------
-- 3. Store #2 — tone/style memory (from shadow mode)
-- ------------------------------------------------------------
create table tone_profiles (
  merchant_id uuid primary key references merchants(id) on delete cascade,
  profile text not null,                 -- distilled prose: voice, formality, sign-off
  tickets_observed int not null default 0,
  updated_at timestamptz not null default now()
);

create table exemplar_replies (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants(id) on delete cascade,
  customer_message text not null,
  human_reply text not null,             -- the reply a human actually sent
  category text,                         -- order-status | returns | refunds | ...
  created_at timestamptz not null default now()
);
create index exemplar_merchant_idx on exemplar_replies (merchant_id, category);

-- ------------------------------------------------------------
-- 4. Store #3 — calibration state (per merchant, self-tuning)
-- ------------------------------------------------------------
create table calibration_state (
  merchant_id uuid primary key references merchants(id) on delete cascade,
  auto_send_threshold numeric(5,2) not null default 80.00,
  updated_at timestamptz not null default now()
);

create table rating_feedback (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants(id) on delete cascade,
  ticket_hash text not null,             -- keccak256, matches ClerkLedger
  confidence numeric(5,2) not null,      -- Clerk's confidence at answer time
  rating smallint check (rating between 1 and 5),
  rater text not null check (rater in ('customer','merchant')),
  created_at timestamptz not null default now()
);
create index feedback_merchant_idx on rating_feedback (merchant_id);

-- ------------------------------------------------------------
-- 5. Ticket index (off-chain mirror; chain holds hash only)
-- ------------------------------------------------------------
create table tickets (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  external_id text not null,             -- e.g. NW-4012 from the ticket system
  ticket_hash text not null unique,      -- keccak256(merchant_id + external_id + body)
  status text not null default 'new',    -- new | pending | finalized | reopened | escalated
  confidence numeric(5,2),
  resolved_by_clerk boolean,
  source_used text,                      -- which chunk/doc grounded the answer
  created_at timestamptz not null default now()
);
create unique index tickets_merchant_ext on tickets (merchant_id, external_id);

-- ------------------------------------------------------------
-- 6. THE ISOLATION WALL — Row-Level Security
--    A merchant's JWT can only ever touch rows with its own
--    merchant_id. The service-role key (Clerk's backend) bypasses
--    RLS by design — it is the operator, same trust model as the
--    contract's `operator` address.
-- ------------------------------------------------------------
alter table merchants         enable row level security;
alter table documents         enable row level security;
alter table doc_chunks        enable row level security;
alter table tone_profiles     enable row level security;
alter table exemplar_replies  enable row level security;
alter table calibration_state enable row level security;
alter table rating_feedback   enable row level security;
alter table tickets           enable row level security;

create policy "own merchant row"   on merchants         for select using (id = auth_merchant_id());
create policy "own documents"      on documents         for all    using (merchant_id = auth_merchant_id());
create policy "own chunks"         on doc_chunks        for all    using (merchant_id = auth_merchant_id());
create policy "own tone"           on tone_profiles     for all    using (merchant_id = auth_merchant_id());
create policy "own exemplars"      on exemplar_replies  for all    using (merchant_id = auth_merchant_id());
create policy "own calibration"    on calibration_state for select using (merchant_id = auth_merchant_id());
create policy "own feedback"       on rating_feedback   for select using (merchant_id = auth_merchant_id());
create policy "own tickets"        on tickets           for all    using (merchant_id = auth_merchant_id());

-- ------------------------------------------------------------
-- 7. Retrieval — the query behind every Clerk answer.
--    merchant_id is a REQUIRED parameter, and even if the caller
--    passed the wrong one, RLS would still fence a merchant JWT.
-- ------------------------------------------------------------
create or replace function match_chunks(
  p_merchant uuid,
  query_embedding vector(384),
  match_count int default 5
)
returns table (content text, document_id uuid, similarity float)
language sql stable
as $$
  select
    c.content,
    c.document_id,
    1 - (c.embedding <=> query_embedding) as similarity
  from doc_chunks c
  where c.merchant_id = p_merchant
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- ------------------------------------------------------------
-- 8. Storage bucket for raw uploads (run once; path = merchant_id/...)
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('merchant-docs','merchant-docs', false)
on conflict do nothing;

create policy "merchant reads own files" on storage.objects for select
  using (bucket_id = 'merchant-docs' and (storage.foldername(name))[1] = auth_merchant_id()::text);
create policy "merchant uploads own files" on storage.objects for insert
  with check (bucket_id = 'merchant-docs' and (storage.foldername(name))[1] = auth_merchant_id()::text);

-- ------------------------------------------------------------
-- Offboarding = one statement. Memory gone; onchain record stays.
--   delete from merchants where id = :merchant_id;
-- (Everything cascades. Reputation on ClerkLedger is untouched —
--  earned publicly, kept publicly.)
-- ------------------------------------------------------------


-- ========== supabase/schema-production.sql ==========
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


-- ========== supabase/schema-conversations.sql ==========
-- ============================================================
-- schema-conversations.sql — multi-turn thread support.
-- Run AFTER schema.sql and schema-production.sql.
-- ============================================================

-- Every message in a ticket thread, in order. A ticket is no longer one
-- message → one answer; it's a conversation with state.
create table ticket_messages (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants(id) on delete cascade,
  ticket_hash text not null,               -- ties to tickets.ticket_hash & onchain record
  role text not null check (role in ('customer','clerk','human')),
  body text not null,
  -- For customer turns, Clerk classifies intent before acting:
  intent text check (intent in ('question','followup','thanks','complaint','other')),
  confidence numeric(5,2),                  -- Clerk's confidence on clerk turns
  source_used text,
  created_at timestamptz not null default now()
);
create index tmsg_thread on ticket_messages (merchant_id, ticket_hash, created_at);

-- Add thread-level state to tickets (idempotent guards for re-runs).
alter table tickets add column if not exists turn_count int not null default 0;
alter table tickets add column if not exists last_customer_intent text;
alter table tickets add column if not exists awaiting text  -- 'customer' | 'clerk' | 'human' | null
  default null;

alter table ticket_messages enable row level security;
create policy "own thread messages" on ticket_messages for all using (merchant_id = auth_merchant_id());

-- Convenience view: full thread text for prompt assembly (service-role reads).
create or replace function thread_history(p_ticket text)
returns table (role text, body text, created_at timestamptz)
language sql stable as $$
  select role, body, created_at
  from ticket_messages
  where ticket_hash = p_ticket
  order by created_at asc
$$;


-- ========== supabase/schema-calibration.sql ==========
-- ============================================================
-- schema-calibration.sql — smarter calibration support.
-- Run AFTER the earlier schema files.
-- ============================================================

-- Per-category auto-send thresholds + measured calibration.
create table category_calibration (
  merchant_id uuid not null references merchants(id) on delete cascade,
  category text not null,                    -- 'shipping','refunds',... or '_default'
  auto_send_threshold numeric(5,2) not null default 80.00,
  mean_confidence numeric(5,2),              -- avg confidence Clerk claimed
  success_rate numeric(5,2),                 -- % rated >= 4 stars
  calibration_gap numeric(5,2),              -- mean_confidence - success_rate (>0 = overconfident)
  samples int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (merchant_id, category)
);
alter table category_calibration enable row level security;
create policy "own category calib" on category_calibration for select using (merchant_id = auth_merchant_id());

-- rating_feedback needs a category column for per-category recalibration.
alter table rating_feedback add column if not exists category text default '_default';

-- Escalation outcomes: was Clerk's handoff note actually useful?
create table escalation_outcomes (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants(id) on delete cascade,
  ticket_hash text not null,
  had_note boolean not null,
  minutes_to_resolve numeric(8,2),
  created_at timestamptz not null default now()
);
alter table escalation_outcomes enable row level security;
create policy "own escalation outcomes" on escalation_outcomes for select using (merchant_id = auth_merchant_id());

-- Pattern detection: find recent tickets at this merchant whose opening message
-- embedding is close to a new one. Requires storing an opening-message embedding
-- per ticket (add the column, backfilled by the server on intake).
alter table tickets add column if not exists open_embedding vector(384);
create index if not exists tickets_open_emb on tickets using hnsw (open_embedding vector_cosine_ops);

create or replace function match_recent_tickets(
  p_merchant uuid,
  query_embedding vector(384),
  since_hours int default 168,
  similarity_floor float default 0.9
)
returns table (ticket_hash text, similarity float, created_at timestamptz)
language sql stable as $$
  select t.ticket_hash,
         1 - (t.open_embedding <=> query_embedding) as similarity,
         t.created_at
  from tickets t
  where t.merchant_id = p_merchant
    and t.open_embedding is not null
    and t.created_at > now() - (since_hours || ' hours')::interval
    and 1 - (t.open_embedding <=> query_embedding) >= similarity_floor
  order by t.open_embedding <=> query_embedding
$$;
