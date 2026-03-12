-- ============================================================
-- COMPREHENSIVE MIGRATION: all missing columns + complaints + storage
-- Safe to run multiple times (IF NOT EXISTS / IF EXISTS guards)
-- ============================================================

-- ── 1. customer_orders: columns that code uses but were never migrated ──

ALTER TABLE public.customer_orders
  ADD COLUMN IF NOT EXISTS payment_id text,
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS delivery_fee numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS refund_status text,
  ADD COLUMN IF NOT EXISTS refund_id text,
  ADD COLUMN IF NOT EXISTS refund_amount numeric,
  ADD COLUMN IF NOT EXISTS moyasar_fee numeric,
  ADD COLUMN IF NOT EXISTS refund_fee numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_fee_absorbed_by text,
  ADD COLUMN IF NOT EXISTS refund_method text,
  ADD COLUMN IF NOT EXISTS commission_amount numeric,
  ADD COLUMN IF NOT EXISTS commission_rate numeric,
  ADD COLUMN IF NOT EXISTS commission_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS driver_lat numeric,
  ADD COLUMN IF NOT EXISTS driver_lng numeric;

-- ── 2. Widen status CHECK to include On Hold and Pending ──

ALTER TABLE public.customer_orders DROP CONSTRAINT IF EXISTS customer_orders_status_check;
ALTER TABLE public.customer_orders
  ADD CONSTRAINT customer_orders_status_check
  CHECK (status IN ('Preparing','Ready','Out for delivery','Delivered','Cancelled','On Hold','Pending'));

-- ── 3. push_subscriptions: add user_id alias (code uses user_id, table has customer_id) ──

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'user_id'
  ) THEN
    -- Add user_id column that mirrors customer_id
    ALTER TABLE public.push_subscriptions ADD COLUMN user_id text;
    -- Backfill from customer_id
    UPDATE public.push_subscriptions SET user_id = customer_id WHERE user_id IS NULL;
    -- Create index for lookup
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON public.push_subscriptions(user_id);
  END IF;
END $$;

-- Trigger to keep user_id in sync when customer_id is set
CREATE OR REPLACE FUNCTION sync_push_sub_user_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.user_id IS NULL AND NEW.customer_id IS NOT NULL THEN
    NEW.user_id := NEW.customer_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_push_sub_user_id ON public.push_subscriptions;
CREATE TRIGGER trg_push_sub_user_id
  BEFORE INSERT OR UPDATE ON public.push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION sync_push_sub_user_id();

-- ── 4. order_complaints table ──

CREATE TABLE IF NOT EXISTS public.order_complaints (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id text NOT NULL REFERENCES public.customer_orders(id),
  merchant_id uuid NOT NULL,
  customer_id text NOT NULL,
  complaint_type text NOT NULL CHECK (complaint_type IN ('missing_item','wrong_item','quality_issue','other')),
  description text,
  photo_urls text[] DEFAULT '{}',
  items jsonb DEFAULT '[]',
  requested_refund_amount numeric,
  approved_refund_amount numeric,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','refunded')),
  merchant_notes text,
  refund_id text,
  refund_method text,
  refund_fee numeric DEFAULT 0,
  flagged boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_order_complaints_order_id ON public.order_complaints(order_id);
CREATE INDEX IF NOT EXISTS idx_order_complaints_merchant_id ON public.order_complaints(merchant_id);
CREATE INDEX IF NOT EXISTS idx_order_complaints_status ON public.order_complaints(status);

ALTER TABLE public.order_complaints ENABLE ROW LEVEL SECURITY;

-- Drop existing policies first to avoid conflicts on re-run
DROP POLICY IF EXISTS "Users can insert own complaints" ON public.order_complaints;
DROP POLICY IF EXISTS "Users can view own complaints" ON public.order_complaints;

CREATE POLICY "Users can insert own complaints"
  ON public.order_complaints FOR INSERT
  WITH CHECK (auth.uid()::text = customer_id);

CREATE POLICY "Users can view own complaints"
  ON public.order_complaints FOR SELECT
  USING (auth.uid()::text = customer_id);

-- ── 5. Complaint photos storage bucket ──

INSERT INTO storage.buckets (id, name, public)
VALUES ('complaint-photos', 'complaint-photos', true)
ON CONFLICT (id) DO NOTHING;

-- Drop existing policies first to avoid conflicts
DROP POLICY IF EXISTS "Authenticated users can upload complaint photos" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view complaint photos" ON storage.objects;

CREATE POLICY "Authenticated users can upload complaint photos"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'complaint-photos' AND auth.role() = 'authenticated');

CREATE POLICY "Anyone can view complaint photos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'complaint-photos');

-- ── 6. Useful indexes for new query patterns ──

CREATE INDEX IF NOT EXISTS idx_customer_orders_merchant_id ON public.customer_orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_customer_orders_status ON public.customer_orders(status);
CREATE INDEX IF NOT EXISTS idx_customer_orders_payment_id ON public.customer_orders(payment_id);
CREATE INDEX IF NOT EXISTS idx_customer_orders_oto_id ON public.customer_orders(oto_id);
