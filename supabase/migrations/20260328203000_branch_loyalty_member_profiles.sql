create table if not exists public.loyalty_member_profiles (
  id uuid primary key default gen_random_uuid(),
  merchant_id text not null,
  customer_id text not null,
  member_code text not null,
  display_name text,
  phone_number text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint loyalty_member_profiles_merchant_customer_key unique (merchant_id, customer_id),
  constraint loyalty_member_profiles_merchant_member_code_key unique (merchant_id, member_code)
);

create index if not exists idx_loyalty_member_profiles_merchant on public.loyalty_member_profiles(merchant_id);
create index if not exists idx_loyalty_member_profiles_customer on public.loyalty_member_profiles(customer_id);
create index if not exists idx_loyalty_member_profiles_member_code on public.loyalty_member_profiles(merchant_id, member_code);

insert into public.loyalty_member_profiles (
  merchant_id,
  customer_id,
  member_code,
  created_at,
  updated_at
)
select
  lp.merchant_id,
  lp.customer_id,
  upper('NK' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  now(),
  now()
from public.loyalty_points lp
where lp.merchant_id is not null
  and lp.customer_id is not null
  and not exists (
    select 1
    from public.loyalty_member_profiles lmp
    where lmp.merchant_id = lp.merchant_id
      and lmp.customer_id = lp.customer_id
  )
on conflict (merchant_id, customer_id) do nothing;

alter table public.loyalty_transactions
  add column if not exists branch_id uuid,
  add column if not exists source text not null default 'app',
  add column if not exists actor_user_id text,
  add column if not exists actor_role text,
  add column if not exists reference_type text,
  add column if not exists reference_id text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists idx_loyalty_transactions_branch on public.loyalty_transactions(branch_id);
create index if not exists idx_loyalty_transactions_reference on public.loyalty_transactions(merchant_id, customer_id, reference_id);
create index if not exists idx_loyalty_transactions_source on public.loyalty_transactions(source);

create unique index if not exists idx_loyalty_transactions_branch_ref_unique
  on public.loyalty_transactions (merchant_id, customer_id, type, source, reference_type, reference_id)
  where source = 'branch' and reference_id is not null;

alter table public.loyalty_member_profiles enable row level security;

drop policy if exists "Users can view own loyalty member profile" on public.loyalty_member_profiles;
create policy "Users can view own loyalty member profile"
  on public.loyalty_member_profiles
  for select
  using (auth.uid()::text = customer_id);
