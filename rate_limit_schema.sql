-- Drop the old table if it exists (since we are changing the schema)
drop table if exists public.rate_limits;

-- Create the rate_limits table to track API usage
-- 'key' can be an IP address (for anon) or a User ID (for auth)
create table public.rate_limits (
  key text not null,
  endpoint text not null,
  count int not null default 1,
  window_start timestamptz not null default now(),
  primary key (key, endpoint)
);

-- Enable RLS
alter table public.rate_limits enable row level security;

-- No policies needed because only the Service Role (Edge Functions) will access this table.
