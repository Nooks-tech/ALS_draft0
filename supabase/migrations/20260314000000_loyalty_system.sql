-- ============================================================================
-- LOYALTY SYSTEM MIGRATION
-- Adds: loyalty_config, loyalty_rewards, loyalty_stamps
-- Alters: loyalty_points (add merchant_id), loyalty_transactions (add expires_at)
-- Safe to run multiple times (IF NOT EXISTS / DO $$ guards)
-- ============================================================================


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  1. loyalty_config – one row per merchant, stores all loyalty settings  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.loyalty_config (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  merchant_id text NOT NULL UNIQUE,
  earn_mode text NOT NULL DEFAULT 'per_sar' CHECK (earn_mode IN ('per_sar', 'per_order')),
  points_per_sar numeric NOT NULL DEFAULT 1,
  points_per_order numeric NOT NULL DEFAULT 10,
  point_value_sar numeric NOT NULL DEFAULT 0.1,
  expiry_months integer,
  stamp_enabled boolean NOT NULL DEFAULT false,
  stamp_target integer NOT NULL DEFAULT 10,
  stamp_reward_description text DEFAULT 'Free item',
  wallet_card_bg_color text,
  wallet_card_text_color text DEFAULT '#FFFFFF',
  wallet_card_logo_url text,
  wallet_card_label text DEFAULT 'Loyalty Card',
  wallet_card_secondary_label text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_config_merchant ON public.loyalty_config(merchant_id);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  2. loyalty_rewards – merchant-defined reward items redeemable by pts  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.loyalty_rewards (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  merchant_id text NOT NULL,
  name text NOT NULL,
  description text,
  image_url text,
  points_cost integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_merchant ON public.loyalty_rewards(merchant_id);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  3. loyalty_stamps – stamp card progress per customer per merchant     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.loyalty_stamps (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id text NOT NULL,
  merchant_id text NOT NULL,
  stamps integer NOT NULL DEFAULT 0,
  completed_cards integer NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (customer_id, merchant_id)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_stamps_customer ON public.loyalty_stamps(customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_stamps_merchant ON public.loyalty_stamps(merchant_id);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  4. Alter existing tables                                               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.loyalty_transactions
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE public.loyalty_transactions
  ADD COLUMN IF NOT EXISTS merchant_id text;

CREATE INDEX IF NOT EXISTS idx_loyalty_tx_merchant ON public.loyalty_transactions(merchant_id);

ALTER TABLE public.loyalty_points
  ADD COLUMN IF NOT EXISTS merchant_id text;

CREATE INDEX IF NOT EXISTS idx_loyalty_points_merchant ON public.loyalty_points(merchant_id);

-- Drop the old unique constraint on customer_id alone so we can have per-merchant rows
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loyalty_points_customer_id_key'
    AND conrelid = 'public.loyalty_points'::regclass
  ) THEN
    ALTER TABLE public.loyalty_points DROP CONSTRAINT loyalty_points_customer_id_key;
  END IF;
END $$;

-- Add compound unique on (customer_id, merchant_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loyalty_points_customer_merchant_key'
    AND conrelid = 'public.loyalty_points'::regclass
  ) THEN
    ALTER TABLE public.loyalty_points ADD CONSTRAINT loyalty_points_customer_merchant_key
      UNIQUE (customer_id, merchant_id);
  END IF;
END $$;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  5. RLS policies                                                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.loyalty_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_stamps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read loyalty config" ON public.loyalty_config;
CREATE POLICY "Anyone can read loyalty config"
  ON public.loyalty_config FOR SELECT USING (true);

DROP POLICY IF EXISTS "Anyone can read active rewards" ON public.loyalty_rewards;
CREATE POLICY "Anyone can read active rewards"
  ON public.loyalty_rewards FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can view own stamps" ON public.loyalty_stamps;
CREATE POLICY "Users can view own stamps"
  ON public.loyalty_stamps FOR SELECT
  USING (auth.uid()::text = customer_id);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  6. Add to realtime publication                                         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'loyalty_points'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.loyalty_points;
  END IF;
END $$;
