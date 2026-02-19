-- ALS-owned promo codes so we don't depend on Nooks' promo_codes schema.
-- App validates against this table; fallback to hardcoded when empty.

create table if not exists public.als_promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  type text not null check (type in ('percentage', 'amount')),
  value numeric not null,
  name text,
  active boolean default true,
  max_uses integer,
  uses_count integer default 0,
  valid_from timestamptz,
  valid_until timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_als_promo_codes_code on public.als_promo_codes (upper(code));

alter table public.als_promo_codes enable row level security;

create policy "Allow public read of active ALS promo codes"
  on public.als_promo_codes for select
  using (active = true);
