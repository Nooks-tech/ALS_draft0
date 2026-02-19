# Promo Codes Setup

## Architecture (from Gemini + implementation)

- **Your DB (Supabase)**: Store promo codes. Restaurant owner creates them via dashboard.
- **App**: Validates codes against Supabase (or fallback hardcoded codes when Supabase isn’t configured).
- **Foodics**: Receives the calculated discount amount with the order. Foodics does **not** validate codes.

## 1. Supabase Setup

1. Create a project at [supabase.com](https://supabase.com).
2. In Supabase SQL Editor, run:

```sql
-- From supabase/migrations/20260216000000_create_promo_codes.sql
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

create index if not exists idx_promo_codes_code on promo_codes (upper(code));
alter table promo_codes enable row level security;

create policy "Allow public read of active promo codes"
  on promo_codes for select using (active = true);
```

3. Add to `.env`:
```
EXPO_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
```

## 2. Add Promo Codes

In Supabase Studio → Table Editor → `promo_codes`:

| code     | type      | value | name        |
|----------|-----------|-------|-------------|
| SUMMER20 | percentage| 0.20  | Summer Sale |
| FLAT10   | amount    | 10    | 10 SAR off  |

- `type`: `percentage` (e.g. 0.20 = 20%) or `amount` (flat SAR).
- `value`: 0.20 for 20%, or 10 for 10 SAR.
- Optional: `max_uses`, `valid_from`, `valid_until`.

## 3. Fallback (No Supabase)

If Supabase is not configured, these codes work out of the box:

- `TEST2026` – 15% off  
- `SAVE15` – 15% off  
- `FLAT10` – 10 SAR off  

## 4. Foodics “Ghost Discount”

To match Foodics receipts:

1. Foodics Console → Manage → Discounts.
2. Create a discount named **“ALS App Promo”**.
3. Set it to **Open Value** (no fixed amount).
4. Get its ID and add to backend env if needed.

The app sends the discount as `amount` + `reference` (code). Foodics shows it as a generic discount; you can use the `reference` to tie it back to the promo code.

## 5. Merchant Dashboard (Optional)

Use Retool, Rowy, or Supabase Studio to let the restaurant owner manage codes (add, edit, deactivate). They write to `promo_codes`; the app reads via Supabase.
