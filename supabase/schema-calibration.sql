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
