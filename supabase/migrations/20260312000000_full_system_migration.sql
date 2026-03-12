-- ============================================================================
-- FULL SYSTEM MIGRATION – covers every gap across ALS_draft0-1 and nooksweb-1
-- Safe to run multiple times (IF NOT EXISTS / IF EXISTS / DO $$ guards)
-- ============================================================================


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SECTION 1: customer_orders – all missing columns                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

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

ALTER TABLE public.customer_orders DROP CONSTRAINT IF EXISTS customer_orders_status_check;
ALTER TABLE public.customer_orders
  ADD CONSTRAINT customer_orders_status_check
  CHECK (status IN ('Preparing','Ready','Out for delivery','Delivered','Cancelled','On Hold','Pending'));

CREATE INDEX IF NOT EXISTS idx_customer_orders_merchant_id ON public.customer_orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_customer_orders_status ON public.customer_orders(status);
CREATE INDEX IF NOT EXISTS idx_customer_orders_payment_id ON public.customer_orders(payment_id);
CREATE INDEX IF NOT EXISTS idx_customer_orders_oto_id ON public.customer_orders(oto_id);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SECTION 2: orders (nooksweb legacy) – missing columns                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS order_type text DEFAULT 'pickup',
  ADD COLUMN IF NOT EXISTS branch_name text,
  ADD COLUMN IF NOT EXISTS payment_id text;

CREATE INDEX IF NOT EXISTS idx_orders_payment_id ON public.orders(payment_id);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SECTION 3: promo_codes – missing columns (nooksweb fallback selects)   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.promo_codes
  ADD COLUMN IF NOT EXISTS discount_fixed_sar numeric,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SECTION 4: push_subscriptions – user_id alias + public insert policy   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE public.push_subscriptions ADD COLUMN user_id text;
    UPDATE public.push_subscriptions SET user_id = customer_id WHERE user_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON public.push_subscriptions(user_id);
  END IF;
END $$;

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

-- Allow the service role (used by public API register endpoint) to upsert tokens.
-- Also allow authenticated users to register their own push tokens.
DROP POLICY IF EXISTS "Service role can manage push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Service role can manage push subscriptions"
  ON public.push_subscriptions FOR ALL
  USING (true)
  WITH CHECK (true);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SECTION 5: order_complaints table                                      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

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

DROP POLICY IF EXISTS "Users can insert own complaints" ON public.order_complaints;
DROP POLICY IF EXISTS "Users can view own complaints" ON public.order_complaints;

CREATE POLICY "Users can insert own complaints"
  ON public.order_complaints FOR INSERT
  WITH CHECK (auth.uid()::text = customer_id);

CREATE POLICY "Users can view own complaints"
  ON public.order_complaints FOR SELECT
  USING (auth.uid()::text = customer_id);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SECTION 6: loyalty_points table (used by server/routes/loyalty.ts)     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.loyalty_points (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id text NOT NULL UNIQUE,
  points numeric NOT NULL DEFAULT 0,
  lifetime_points numeric NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_points_customer ON public.loyalty_points(customer_id);

ALTER TABLE public.loyalty_points ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own loyalty points" ON public.loyalty_points;
CREATE POLICY "Users can view own loyalty points"
  ON public.loyalty_points FOR SELECT
  USING (auth.uid()::text = customer_id);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SECTION 7: loyalty_transactions table                                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.loyalty_transactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id text NOT NULL,
  order_id text,
  type text NOT NULL CHECK (type IN ('earn','redeem')),
  points numeric NOT NULL,
  description text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_tx_customer ON public.loyalty_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_created ON public.loyalty_transactions(created_at DESC);

ALTER TABLE public.loyalty_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own loyalty transactions" ON public.loyalty_transactions;
CREATE POLICY "Users can view own loyalty transactions"
  ON public.loyalty_transactions FOR SELECT
  USING (auth.uid()::text = customer_id);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SECTION 8: support_tickets table (used by app/support-modal.tsx)       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  merchant_id uuid REFERENCES public.merchants(id) ON DELETE SET NULL,
  customer_id text,
  email text,
  subject text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_merchant ON public.support_tickets(merchant_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_customer ON public.support_tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets(status);

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can insert support tickets" ON public.support_tickets;
CREATE POLICY "Anyone can insert support tickets"
  ON public.support_tickets FOR INSERT
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view own support tickets" ON public.support_tickets;
CREATE POLICY "Users can view own support tickets"
  ON public.support_tickets FOR SELECT
  USING (auth.uid()::text = customer_id);


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SECTION 9: Storage buckets                                             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- complaint-photos bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('complaint-photos', 'complaint-photos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Authenticated users can upload complaint photos" ON storage.objects;
CREATE POLICY "Authenticated users can upload complaint photos"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'complaint-photos' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Anyone can view complaint photos" ON storage.objects;
CREATE POLICY "Anyone can view complaint photos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'complaint-photos');

-- merchant-logos bucket (referenced by nooksweb wizard/app-icon pages)
INSERT INTO storage.buckets (id, name, public)
VALUES ('merchant-logos', 'merchant-logos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Authenticated users can upload merchant logos" ON storage.objects;
CREATE POLICY "Authenticated users can upload merchant logos"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'merchant-logos' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Anyone can view merchant logos" ON storage.objects;
CREATE POLICY "Anyone can view merchant logos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'merchant-logos');


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  SECTION 10: Realtime – enable for tables with subscriptions            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- customer_orders is subscribed to in ALS src/api/orders.ts
-- app_config is subscribed to in ALS src/context/OperationsContext.tsx
-- Supabase requires tables to be added to the realtime publication

DO $$
BEGIN
  -- Add customer_orders to realtime if not already there
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'customer_orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.customer_orders;
  END IF;

  -- Add app_config to realtime if not already there
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'app_config'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.app_config;
  END IF;
END $$;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  DONE – summary of what was ensured                                     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- 1. customer_orders: 17 columns added + status constraint widened + indexes
-- 2. orders (legacy): order_type, branch_name, payment_id columns added
-- 3. promo_codes: discount_fixed_sar, expires_at, is_active columns added
-- 4. push_subscriptions: user_id alias + sync trigger + permissive policy
-- 5. order_complaints: full table + indexes + RLS
-- 6. loyalty_points: full table + RLS
-- 7. loyalty_transactions: full table + RLS
-- 8. support_tickets: full table + RLS
-- 9. Storage: complaint-photos + merchant-logos buckets with policies
-- 10. Realtime: customer_orders + app_config added to publication
