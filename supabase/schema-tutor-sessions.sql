-- ============================================================
-- schema-tutor-sessions.sql — groups tutor_turns into rehearsal
-- threads so the "Tutor Clerk" dashboard panel can be multi-turn,
-- the same way a real ticket_messages thread is (conversation.mjs).
-- Grading stays per-turn (tutor_turns.id / verdict / correction) —
-- session_id only groups existing rows, no new table needed.
-- Run AFTER schema-tutor.sql.
-- ============================================================

alter table tutor_turns add column if not exists session_id uuid not null default gen_random_uuid();
create index if not exists tutor_turns_session_idx on tutor_turns (merchant_id, session_id, created_at);
