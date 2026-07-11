-- ============================================================
-- schema-auth-link.sql — a merchant account no longer requires a wallet
-- up front. Google sign-in creates the account (auth_user_id); a wallet
-- can be linked later from inside the dashboard, onto the SAME row.
-- Run AFTER schema-tutor.sql.
-- ============================================================

alter table merchants alter column wallet_address drop not null;
alter table merchants add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

-- Every merchant still needs SOME identity — just not necessarily a wallet.
alter table merchants drop constraint if exists merchants_identity_present;
alter table merchants add constraint merchants_identity_present
  check (wallet_address is not null or auth_user_id is not null);
