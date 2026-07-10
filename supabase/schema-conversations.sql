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
