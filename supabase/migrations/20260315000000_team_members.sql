-- ============================================================================
-- TEAM MEMBERS – Owner/Manager roles with branch scoping
-- ============================================================================

-- 1. team_members table
create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid references public.merchants(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete set null,
  email text not null,
  role text not null default 'manager' check (role in ('owner', 'manager')),
  branch_ids uuid[] default '{}',
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  invited_at timestamptz default now(),
  accepted_at timestamptz
);

create index if not exists idx_team_members_merchant on public.team_members (merchant_id);
create index if not exists idx_team_members_user on public.team_members (user_id) where user_id is not null;
create index if not exists idx_team_members_email on public.team_members (email);
create unique index if not exists idx_team_members_merchant_email on public.team_members (merchant_id, email) where status != 'revoked';

alter table public.team_members enable row level security;

-- Helper functions to avoid infinite recursion between merchants ↔ team_members policies
create or replace function public.current_owner_merchant_id() returns uuid as $$
  select id from public.merchants where user_id = auth.uid() limit 1;
$$ language sql security definer stable;

create or replace function public.current_team_merchant_id() returns uuid as $$
  select merchant_id from public.team_members where user_id = auth.uid() and status = 'active' limit 1;
$$ language sql security definer stable;

-- RLS: owners can manage their merchant's team; managers can read their own row
drop policy if exists "Owner can manage team" on public.team_members;
create policy "Owner can manage team"
  on public.team_members for all
  using (
    merchant_id = public.current_owner_merchant_id()
  );

drop policy if exists "Team member can read own" on public.team_members;
create policy "Team member can read own"
  on public.team_members for select
  using (user_id = auth.uid());

-- 2. Update current_user_merchant_id() to also check team_members
create or replace function public.current_user_merchant_id() returns uuid as $$
  select coalesce(
    (select id from public.merchants where user_id = auth.uid() limit 1),
    (select merchant_id from public.team_members where user_id = auth.uid() and status = 'active' limit 1)
  );
$$ language sql security definer stable;

-- 3. Helper: current_user_role()
create or replace function public.current_user_role() returns text as $$
begin
  if exists (select 1 from public.merchants where user_id = auth.uid()) then
    return 'owner';
  end if;
  if exists (select 1 from public.team_members where user_id = auth.uid() and status = 'active') then
    return 'manager';
  end if;
  return null;
end;
$$ language plpgsql security definer stable;

-- 4. Helper: current_user_branch_ids()
create or replace function public.current_user_branch_ids() returns uuid[] as $$
  select coalesce(
    (select branch_ids from public.team_members where user_id = auth.uid() and status = 'active' limit 1),
    '{}'::uuid[]
  );
$$ language sql security definer stable;

-- 5. Ensure owners can always read & update their own merchant row (safe if RLS is on)
do $$
begin
  if not exists (
    select 1 from pg_policies where policyname = 'Owner can read own merchant' and tablename = 'merchants'
  ) then
    create policy "Owner can read own merchant"
      on public.merchants for select
      using (user_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies where policyname = 'Owner can update own merchant' and tablename = 'merchants'
  ) then
    create policy "Owner can update own merchant"
      on public.merchants for update
      using (user_id = auth.uid());
  end if;
end $$;

-- 6. Allow team members to read the merchant they belong to (uses SECURITY DEFINER to avoid recursion)
do $$
begin
  if not exists (
    select 1 from pg_policies where policyname = 'Team members can read merchant' and tablename = 'merchants'
  ) then
    create policy "Team members can read merchant"
      on public.merchants for select
      using (id = public.current_team_merchant_id());
  end if;
end $$;

-- 6. Add team_members to realtime publication
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'team_members'
  ) then
    alter publication supabase_realtime add table public.team_members;
  end if;
end $$;
