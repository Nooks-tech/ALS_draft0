-- =============================================================================
-- Per-customer loyalty type tracking
-- =============================================================================
-- When a merchant changes loyalty type, only NEW customers get the new type.
-- Old customers keep their original type forever unless they opt in by
-- deleting their Apple Pass card and adding a new one.
-- =============================================================================

-- 1. Allow null loyalty_type (unactivated merchant)
ALTER TABLE IF EXISTS public.loyalty_config ALTER COLUMN loyalty_type DROP NOT NULL;
ALTER TABLE IF EXISTS public.loyalty_config ALTER COLUMN loyalty_type DROP DEFAULT;
ALTER TABLE IF EXISTS public.loyalty_config DROP CONSTRAINT IF EXISTS loyalty_config_loyalty_type_check;
ALTER TABLE IF EXISTS public.loyalty_config ADD CONSTRAINT loyalty_config_loyalty_type_check
  CHECK (loyalty_type IS NULL OR loyalty_type IN ('cashback', 'points', 'stamps'));

-- 2. Add per-customer loyalty type to loyalty_member_profiles
ALTER TABLE IF EXISTS public.loyalty_member_profiles
  ADD COLUMN IF NOT EXISTS active_loyalty_type text,
  ADD COLUMN IF NOT EXISTS loyalty_type_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS loyalty_type_opted_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS pass_deleted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pass_deleted_at timestamptz;

-- Constraint: valid loyalty types only
DO $$ BEGIN
  ALTER TABLE public.loyalty_member_profiles
    ADD CONSTRAINT loyalty_member_profiles_active_type_check
    CHECK (active_loyalty_type IS NULL OR active_loyalty_type IN ('cashback', 'points', 'stamps'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Index for fast lookup by customer + merchant
CREATE INDEX IF NOT EXISTS idx_loyalty_member_profiles_customer_merchant
  ON public.loyalty_member_profiles(customer_id, merchant_id);
