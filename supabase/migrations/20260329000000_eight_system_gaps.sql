-- ============================================================================
-- EIGHT SYSTEM GAPS — Unified Migration
-- Gaps: Foodics tracking, loyalty expiration, loyalty programs, complaint
--       escalation, complaint liability, wallet pass templates
-- Safe to run multiple times (IF NOT EXISTS / DO $$ guards)
-- ============================================================================


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Gap 1: Foodics order tracking on customer_orders                      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.customer_orders
  ADD COLUMN IF NOT EXISTS foodics_order_id text;

CREATE INDEX IF NOT EXISTS idx_customer_orders_foodics_order_id
  ON public.customer_orders(foodics_order_id)
  WHERE foodics_order_id IS NOT NULL;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Gap 3: Loyalty point expiration enforcement                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.loyalty_transactions
  ADD COLUMN IF NOT EXISTS expired boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_loyalty_tx_expiry_pending
  ON public.loyalty_transactions(expires_at)
  WHERE expires_at IS NOT NULL AND expired = false AND type = 'earn';


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Gap 4: Loyalty program versioning (Retire & Launch)                   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.loyalty_programs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  merchant_id text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retiring', 'retired')),
  config_snapshot jsonb NOT NULL DEFAULT '{}',
  grace_period_end timestamptz,
  created_at timestamptz DEFAULT now(),
  retired_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_loyalty_programs_merchant
  ON public.loyalty_programs(merchant_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_programs_active
  ON public.loyalty_programs(merchant_id, status)
  WHERE status = 'active';

-- Add nullable program_id FK to all loyalty tables (backwards-compatible)
ALTER TABLE public.loyalty_points
  ADD COLUMN IF NOT EXISTS program_id uuid REFERENCES public.loyalty_programs(id);
ALTER TABLE public.loyalty_stamps
  ADD COLUMN IF NOT EXISTS program_id uuid REFERENCES public.loyalty_programs(id);
ALTER TABLE public.loyalty_transactions
  ADD COLUMN IF NOT EXISTS program_id uuid REFERENCES public.loyalty_programs(id);
ALTER TABLE public.loyalty_rewards
  ADD COLUMN IF NOT EXISTS program_id uuid REFERENCES public.loyalty_programs(id);

CREATE INDEX IF NOT EXISTS idx_loyalty_points_program
  ON public.loyalty_points(program_id)
  WHERE program_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_program
  ON public.loyalty_transactions(program_id)
  WHERE program_id IS NOT NULL;

-- RLS for loyalty_programs
ALTER TABLE public.loyalty_programs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read loyalty programs" ON public.loyalty_programs;
CREATE POLICY "Anyone can read loyalty programs"
  ON public.loyalty_programs FOR SELECT USING (true);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Gap 5: Complaint HQ escalation timer                                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.order_complaints
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalated_to text,
  ADD COLUMN IF NOT EXISTS escalation_reason text;

-- Widen status CHECK to include 'escalated'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_complaints_status_check'
    AND conrelid = 'public.order_complaints'::regclass
  ) THEN
    ALTER TABLE public.order_complaints DROP CONSTRAINT order_complaints_status_check;
  END IF;
END $$;

ALTER TABLE public.order_complaints
  ADD CONSTRAINT order_complaints_status_check
  CHECK (status IN ('pending','approved','rejected','refunded','escalated'));

CREATE INDEX IF NOT EXISTS idx_order_complaints_pending_no_escalation
  ON public.order_complaints(created_at)
  WHERE status = 'pending' AND escalated_at IS NULL;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Gap 6: STORE/FLEET liability tagging + delivery complaint types       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.order_complaints
  ADD COLUMN IF NOT EXISTS suggested_liability text,
  ADD COLUMN IF NOT EXISTS oto_escalated boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS oto_escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS oto_escalation_notes text;

-- Widen complaint_type CHECK to include delivery-related types
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_complaints_complaint_type_check'
    AND conrelid = 'public.order_complaints'::regclass
  ) THEN
    ALTER TABLE public.order_complaints DROP CONSTRAINT order_complaints_complaint_type_check;
  END IF;
END $$;

ALTER TABLE public.order_complaints
  ADD CONSTRAINT order_complaints_complaint_type_check
  CHECK (complaint_type IN (
    'missing_item', 'wrong_item', 'quality_issue', 'other',
    'damaged_packaging', 'late_delivery', 'tampered'
  ));


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Gap 7: Apple Wallet pass design templates                             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.loyalty_config
  ADD COLUMN IF NOT EXISTS pass_template_type text DEFAULT 'classic';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loyalty_config_pass_template_check'
    AND conrelid = 'public.loyalty_config'::regclass
  ) THEN
    ALTER TABLE public.loyalty_config
      ADD CONSTRAINT loyalty_config_pass_template_check
      CHECK (pass_template_type IN ('classic', 'minimal', 'premium'));
  END IF;
END $$;
