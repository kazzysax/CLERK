-- ============================================================
-- schema-widget.sql — embeddable website widget + standby learning
-- Run AFTER schema.sql, schema-production, schema-conversations, schema-calibration
-- ============================================================

-- Merchant embed keys (public site key shown in install snippet)
alter table merchants add column if not exists mode text not null default 'standby'
  check (mode in ('standby', 'live'));
-- standby = always draft + learn, never auto-reply to end customers
-- live    = auto-reply when confidence >= threshold; still always learn from humans

alter table merchants add column if not exists widget_public_key text unique;
alter table merchants add column if not exists widget_allowed_origins text[] default '{}';
alter table merchants add column if not exists widget_greeting text
  default 'Hi — I''m clerk.io. How can we help?';
alter table merchants add column if not exists widget_accent text default '#22F3EE';
alter table merchants add column if not exists widget_title text default 'clerk.io support';

-- Website visitor sessions (the dangling bubble chat)
create table if not exists widget_sessions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  session_token text not null unique,
  visitor_id text,
  page_url text,
  status text not null default 'open'
    check (status in ('open', 'awaiting_human', 'resolved_by_clerk', 'resolved_by_human', 'closed')),
  ticket_hash text,
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists widget_sessions_merchant on widget_sessions (merchant_id, created_at desc);
create index if not exists widget_sessions_token on widget_sessions (session_token);

alter table widget_sessions enable row level security;
create policy "own widget sessions" on widget_sessions for select
  using (merchant_id = auth_merchant_id());

-- Shadow / standby drafts: what Clerk would have said (always stored)
create table if not exists shadow_drafts (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants(id) on delete cascade,
  session_id uuid references widget_sessions(id) on delete set null,
  ticket_hash text,
  customer_message text not null,
  clerk_draft text not null,
  confidence numeric(5,2) not null,
  source_used text,
  shown_to_customer boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists shadow_drafts_merchant on shadow_drafts (merchant_id, created_at desc);

alter table shadow_drafts enable row level security;
create policy "own shadow drafts" on shadow_drafts for select
  using (merchant_id = auth_merchant_id());

-- Every human resolution becomes training fuel (standby is permanent learning)
create table if not exists learning_events (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants(id) on delete cascade,
  ticket_hash text,
  session_id uuid references widget_sessions(id) on delete set null,
  customer_message text not null,
  human_reply text not null,
  clerk_draft text,                    -- what Clerk would have said (if any)
  clerk_confidence numeric(5,2),
  source text not null default 'human_resolve'
    check (source in ('human_resolve', 'webhook', 'widget_desk', 'import')),
  created_at timestamptz not null default now()
);
create index if not exists learning_events_merchant on learning_events (merchant_id, created_at desc);

alter table learning_events enable row level security;
create policy "own learning events" on learning_events for select
  using (merchant_id = auth_merchant_id());

-- Optional: pending human queue for widget escalations
create table if not exists widget_queue (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants(id) on delete cascade,
  session_id uuid not null references widget_sessions(id) on delete cascade,
  clerk_draft text,
  confidence numeric(5,2),
  status text not null default 'open' check (status in ('open', 'claimed', 'done')),
  created_at timestamptz not null default now()
);
create index if not exists widget_queue_open on widget_queue (merchant_id, status, created_at);

alter table widget_queue enable row level security;
create policy "own widget queue" on widget_queue for all
  using (merchant_id = auth_merchant_id());
