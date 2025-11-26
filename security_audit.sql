-- 🛡️ SECURITY AUDIT & LOCKDOWN SCRIPT
-- Run this to ensure ALL your tables are protected by Row Level Security (RLS).

-- 1. Enable RLS on all known tables (Safe to run even if already enabled)
alter table public.quizzes enable row level security;
alter table public.groups enable row level security;
alter table public.quiz_scores enable row level security;
alter table public.group_scores enable row level security;
alter table public.file_chunks enable row level security;
alter table public.quiz_share_links enable row level security;
alter table public.quiz_share_attempts enable row level security;
alter table public.quiz_share_scores enable row level security;

-- 2. Policy: file_chunks (PRIVATE - Service Role Only)
-- Users should NEVER read this table directly. Only Edge Functions need access.
drop policy if exists "Service Role Only" on public.file_chunks;
create policy "Service Role Only"
  on public.file_chunks
  for all
  using ( auth.role() = 'service_role' );

-- 3. Policy: Quizzes (Users manage their own)
drop policy if exists "Users manage own quizzes" on public.quizzes;
create policy "Users manage own quizzes"
  on public.quizzes
  for all
  using ( auth.uid() = user_id );

-- 4. Policy: Groups (Users manage their own)
drop policy if exists "Users manage own groups" on public.groups;
create policy "Users manage own groups"
  on public.groups
  for all
  using ( auth.uid() = user_id );

-- 5. Policy: Scores (Users view their own)
drop policy if exists "Users view own scores" on public.quiz_scores;
create policy "Users view own scores"
  on public.quiz_scores
  for all
  using ( auth.uid() = user_id );

-- 6. Policy: Group Scores (Users view their own)
drop policy if exists "Users view own group scores" on public.group_scores;
create policy "Users view own group scores"
  on public.group_scores
  for all
  using ( auth.uid() = user_id );

-- Note: Shared Quiz tables (quiz_share_*) likely have complex policies already.
-- We enabled RLS on them above (step 1) just in case, but we won't overwrite their policies here
-- to avoid breaking the sharing logic.
