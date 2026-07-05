-- Scalability audit H2 (2026-07-05): all 5 ALS Railway crons are plain
-- setInterval calls — every replica runs every cron, so scaling the
-- Express service to 2+ replicas would double-run loyalty expiration
-- (double-deducting customer balances) and double-send cart pushes.
-- This table + RPC provide an atomic tick claim: the first replica to
-- claim a (name, ttl) window runs the tick, everyone else skips.
--
-- The claim is a single INSERT ... ON CONFLICT DO UPDATE ... WHERE the
-- previous lock expired — atomic under concurrency (row lock), returns
-- true only to the winner. TTLs are sized per-cron to comfortably cover
-- a tick's worst-case duration; an expired TTL simply lets the next
-- tick claim (crash recovery).

create table if not exists public.cron_locks (
  name text primary key,
  locked_until timestamptz not null default now(),
  holder text,
  claimed_at timestamptz not null default now()
);

alter table public.cron_locks enable row level security;

-- supabaseAdmin (service_role) needs an explicit policy — RLS-enabled
-- tables silently no-op service-role UPDATEs without one on this project.
drop policy if exists "service_role_all" on public.cron_locks;
create policy "service_role_all" on public.cron_locks
  for all to service_role using (true) with check (true);

revoke all on table public.cron_locks from public, anon, authenticated;

create or replace function public.try_claim_cron(
  p_name text,
  p_ttl_seconds integer,
  p_holder text default null
)
returns boolean
language sql
security definer
as $$
  insert into public.cron_locks as cl (name, locked_until, holder, claimed_at)
  values (p_name, now() + make_interval(secs => p_ttl_seconds), p_holder, now())
  on conflict (name) do update
    set locked_until = excluded.locked_until,
        holder = excluded.holder,
        claimed_at = now()
    where cl.locked_until < now()
  returning true;
$$;

revoke all on function public.try_claim_cron(text, integer, text) from public, anon, authenticated;
