-- Promo codes table for ALS app
-- Restaurant owner creates codes via dashboard (Retool/Rowy/Supabase Studio)
-- App validates against this table; discount is sent to Foodics as "Ghost" discount

create table if not exists promo_codes (
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

-- Index for fast lookup by code
create index if not exists idx_promo_codes_code on promo_codes (upper(code));

-- RLS: allow anonymous read for active codes (app validates; no sensitive data)
alter table promo_codes enable row level security;

create policy "Allow public read of active promo codes"
  on promo_codes for select
  using (active = true);

-- Merchant dashboard would use service role or authenticated user to insert/update
-- For now, insert via Supabase Studio or dashboard

-- Example seed (run manually if needed):
-- insert into promo_codes (code, type, value, name) values
--   ('TEST2026', 'percentage', 0.15, 'Test 15% off'),
--   ('FLAT10', 'amount', 10, '10 SAR off');
