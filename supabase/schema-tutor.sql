-- ============================================================
-- schema-tutor.sql — merchant "train Clerk" dashboard: FAQ upload
-- (documents/doc_chunks already exist in schema.sql) + a private
-- tutoring Q&A loop with verdicts and corrections.
-- Run AFTER schema-widget.sql in the Supabase SQL editor.
-- ============================================================

create table if not exists tutor_turns (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  question text not null,
  draft text not null,
  confidence numeric(5,2) not null,
  source_used text,
  verdict text not null default 'pending' check (verdict in ('pending', 'good', 'corrected')),
  correction text,
  created_at timestamptz not null default now()
);
create index if not exists tutor_turns_merchant on tutor_turns (merchant_id, created_at desc);

alter table tutor_turns enable row level security;
create policy "own tutor turns" on tutor_turns for select
  using (merchant_id = auth_merchant_id());

-- A tutoring correction is training fuel exactly like a human resolving a
-- real ticket — it just doesn't have a customer behind it. Extend the
-- existing learning_events source list rather than inventing a parallel path.
alter table learning_events drop constraint if exists learning_events_source_check;
alter table learning_events add constraint learning_events_source_check
  check (source in ('human_resolve', 'webhook', 'widget_desk', 'import', 'merchant_tutor'));
