-- ============================================================================
-- THREE LOYALTY SYSTEMS — Cashback / Points / Stamps
-- Adds: loyalty_type, cashback fields, stamp milestones, stamp redemptions,
--       cashback balances, config versioning for soft-transition,
--       wallet card banner/stamp customization
-- Safe to run multiple times (IF NOT EXISTS / DO $$ guards)
-- ============================================================================


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  1. Alter loyalty_config — add loyalty_type + new fields               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Loyalty system type (merchant picks one)
ALTER TABLE public.loyalty_config
  ADD COLUMN IF NOT EXISTS loyalty_type text NOT NULL DEFAULT 'points';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loyalty_config_loyalty_type_check'
    AND conrelid = 'public.loyalty_config'::regclass
  ) THEN
    ALTER TABLE public.loyalty_config
      ADD CONSTRAINT loyalty_config_loyalty_type_check
      CHECK (loyalty_type IN ('cashback', 'points', 'stamps'));
  END IF;
END $$;

-- Cashback specific
ALTER TABLE public.loyalty_config
  ADD COLUMN IF NOT EXISTS cashback_percent numeric DEFAULT 5;

-- Wallet card: banner image (rectangular hero/behind area)
ALTER TABLE public.loyalty_config
  ADD COLUMN IF NOT EXISTS wallet_card_banner_url text;

-- Stamp card customization
ALTER TABLE public.loyalty_config
  ADD COLUMN IF NOT EXISTS wallet_stamp_box_color text DEFAULT '#10B981';
ALTER TABLE public.loyalty_config
  ADD COLUMN IF NOT EXISTS wallet_stamp_icon_color text DEFAULT '#FFFFFF';
ALTER TABLE public.loyalty_config
  ADD COLUMN IF NOT EXISTS wallet_stamp_icon_url text;
ALTER TABLE public.loyalty_config
  ADD COLUMN IF NOT EXISTS business_type text DEFAULT 'cafe';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loyalty_config_business_type_check'
    AND conrelid = 'public.loyalty_config'::regclass
  ) THEN
    ALTER TABLE public.loyalty_config
      ADD CONSTRAINT loyalty_config_business_type_check
      CHECK (business_type IN ('cafe', 'restaurant'));
  END IF;
END $$;

-- Config versioning for soft-transition when merchant changes type/rates
ALTER TABLE public.loyalty_config
  ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.loyalty_config
  ADD COLUMN IF NOT EXISTS previous_loyalty_type text;
ALTER TABLE public.loyalty_config
  ADD COLUMN IF NOT EXISTS config_changed_at timestamptz;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  2. Stamp milestones — rewards at specific stamp counts                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.loyalty_stamp_milestones (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  merchant_id text NOT NULL,
  stamp_number integer NOT NULL CHECK (stamp_number >= 1 AND stamp_number <= 10),
  reward_name text NOT NULL,
  reward_description text,
  foodics_product_ids jsonb DEFAULT '[]',
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (merchant_id, stamp_number)
);

CREATE INDEX IF NOT EXISTS idx_stamp_milestones_merchant
  ON public.loyalty_stamp_milestones(merchant_id);

ALTER TABLE public.loyalty_stamp_milestones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read stamp milestones" ON public.loyalty_stamp_milestones;
CREATE POLICY "Anyone can read stamp milestones"
  ON public.loyalty_stamp_milestones FOR SELECT USING (true);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  3. Stamp redemptions — tracks milestone redemptions per customer      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.loyalty_stamp_redemptions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id text NOT NULL,
  merchant_id text NOT NULL,
  milestone_id uuid REFERENCES public.loyalty_stamp_milestones(id),
  stamp_number integer NOT NULL,
  foodics_coupon_code text,
  foodics_coupon_id text,
  redeemed_at timestamptz,
  redeemed_via text CHECK (redeemed_via IN ('app', 'branch')),
  expires_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stamp_redemptions_customer
  ON public.loyalty_stamp_redemptions(customer_id, merchant_id);

ALTER TABLE public.loyalty_stamp_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own stamp redemptions" ON public.loyalty_stamp_redemptions;
CREATE POLICY "Users can view own stamp redemptions"
  ON public.loyalty_stamp_redemptions FOR SELECT
  USING (auth.uid()::text = customer_id);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  4. Cashback balances — real SAR per customer per merchant              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.loyalty_cashback_balances (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id text NOT NULL,
  merchant_id text NOT NULL,
  balance_sar numeric NOT NULL DEFAULT 0,
  config_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (customer_id, merchant_id, config_version)
);

CREATE INDEX IF NOT EXISTS idx_cashback_balances_customer
  ON public.loyalty_cashback_balances(customer_id, merchant_id);

ALTER TABLE public.loyalty_cashback_balances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own cashback" ON public.loyalty_cashback_balances;
CREATE POLICY "Users can view own cashback"
  ON public.loyalty_cashback_balances FOR SELECT
  USING (auth.uid()::text = customer_id);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  5. Add config_version to existing balance/transaction tables           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.loyalty_points
  ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.loyalty_stamps
  ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.loyalty_transactions
  ADD COLUMN IF NOT EXISTS loyalty_type text;
ALTER TABLE public.loyalty_transactions
  ADD COLUMN IF NOT EXISTS amount_sar numeric;
ALTER TABLE public.loyalty_transactions
  ADD COLUMN IF NOT EXISTS config_version integer;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  6. Realtime for new tables                                             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'loyalty_cashback_balances'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.loyalty_cashback_balances;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'loyalty_stamp_milestones'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.loyalty_stamp_milestones;
  END IF;
END $$;
