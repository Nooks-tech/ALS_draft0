-- Per-merchant customer profiles — closes the last "shared identity"
-- leak in the white-label model.
--
-- Pre-fix, the `profiles` table stored (full_name, phone_number,
-- avatar_url) as ONE GLOBAL ROW per auth user. When the same human
-- (same phone) installed two different merchant-branded apps, both
-- apps read the same `profiles` row — so the name they typed at
-- merchant A appeared in merchant B's app. That's the data leak the
-- audit identified as the #1 gap.
--
-- Fix: introduce a per-merchant profile keyed on
-- (merchant_id, customer_id). The global `profiles` table stays as
-- pure identity (phone only) for auth.users lookups, but every
-- customer-facing display name, email, language pref, avatar, and
-- marketing opt-in moves here.
--
-- Backfill: every row in merchant_customers (the Phase 6 enrollment
-- table) gets a row here, populated from the legacy global profile
-- and the customer's most recent push_subscription (for language and
-- marketing opt-in). Customers whose legacy profile is empty will see
-- empty fields on first read — the app prompts them to fill in.

CREATE TABLE IF NOT EXISTS public.customer_merchant_profiles (
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  customer_id text NOT NULL,
  full_name text,
  email text,
  language text CHECK (language IS NULL OR language IN ('en', 'ar')),
  avatar_url text,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_merchant_profiles_customer
  ON public.customer_merchant_profiles (customer_id);

ALTER TABLE public.customer_merchant_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own merchant profile" ON public.customer_merchant_profiles;
CREATE POLICY "Users can view own merchant profile"
  ON public.customer_merchant_profiles FOR SELECT
  USING (auth.uid()::text = customer_id);

DROP POLICY IF EXISTS "Users can insert own merchant profile" ON public.customer_merchant_profiles;
CREATE POLICY "Users can insert own merchant profile"
  ON public.customer_merchant_profiles FOR INSERT
  WITH CHECK (auth.uid()::text = customer_id);

DROP POLICY IF EXISTS "Users can update own merchant profile" ON public.customer_merchant_profiles;
CREATE POLICY "Users can update own merchant profile"
  ON public.customer_merchant_profiles FOR UPDATE
  USING (auth.uid()::text = customer_id);

-- ── Backfill from merchant_customers + legacy profile + push_subscription
--
-- Each (merchant, customer) pair that already exists in
-- merchant_customers gets a per-merchant profile row populated from:
--   - profiles.full_name (the legacy global name)
--   - push_subscriptions.app_language (most-recent token per pair)
--   - push_subscriptions.marketing_opt_in (same)
-- ON CONFLICT DO NOTHING — re-running this migration won't overwrite
-- per-merchant edits made after the initial backfill.
INSERT INTO public.customer_merchant_profiles (
  merchant_id, customer_id, full_name, language, marketing_opt_in, created_at, updated_at
)
SELECT
  mc.merchant_id,
  mc.customer_id,
  p.full_name,
  ps.app_language,
  COALESCE(ps.marketing_opt_in, false),
  mc.enrolled_at,
  mc.enrolled_at
FROM public.merchant_customers mc
LEFT JOIN public.profiles p ON p.id::text = mc.customer_id
LEFT JOIN LATERAL (
  SELECT app_language, COALESCE(marketing_opt_in, false) AS marketing_opt_in
  FROM public.push_subscriptions
  WHERE merchant_id = mc.merchant_id
    AND customer_id = mc.customer_id
  ORDER BY COALESCE(last_seen_at, created_at) DESC NULLS LAST
  LIMIT 1
) ps ON true
ON CONFLICT (merchant_id, customer_id) DO NOTHING;

-- Helper: keep updated_at fresh on every row change. The trigger uses
-- pg_trigger_depth() = 1 so cascaded updates from joined tables don't
-- bump the timestamp (purely a defensive pattern; we don't have such
-- cascades today but it's the cheapest insurance).
CREATE OR REPLACE FUNCTION public.tg_customer_merchant_profiles_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_merchant_profiles_touch
  ON public.customer_merchant_profiles;
CREATE TRIGGER trg_customer_merchant_profiles_touch
  BEFORE UPDATE ON public.customer_merchant_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_customer_merchant_profiles_touch();
