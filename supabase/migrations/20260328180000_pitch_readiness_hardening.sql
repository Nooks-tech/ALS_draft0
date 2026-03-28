-- ============================================================================
-- Pitch-readiness hardening migration
-- Safe to run multiple times
-- Covers complaint timing, support ticket trust, and delivery completion state
-- ============================================================================

-- ----------------------------------------------------------------------------
-- customer_orders / orders: delivered_at support + automatic tracking
-- ----------------------------------------------------------------------------

ALTER TABLE public.customer_orders
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

UPDATE public.customer_orders
SET delivered_at = COALESCE(delivered_at, updated_at, created_at)
WHERE status = 'Delivered' AND delivered_at IS NULL;

UPDATE public.orders
SET delivered_at = COALESCE(delivered_at, updated_at, created_at)
WHERE status IN ('delivered', 'Delivered') AND delivered_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_customer_orders_delivered_at
  ON public.customer_orders(delivered_at DESC);

CREATE OR REPLACE FUNCTION public.sync_order_delivered_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'Delivered' AND NEW.delivered_at IS NULL THEN
    NEW.delivered_at := COALESCE(NEW.updated_at, now());
  ELSIF NEW.status <> 'Delivered' AND TG_OP = 'INSERT' THEN
    NEW.delivered_at := NULL;
  END IF;

  IF NEW.updated_at IS NULL THEN
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_orders_sync_delivered_at ON public.customer_orders;
CREATE TRIGGER trg_customer_orders_sync_delivered_at
  BEFORE INSERT OR UPDATE ON public.customer_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_order_delivered_at();

-- ----------------------------------------------------------------------------
-- order_complaints: enforce one complaint per order at the database level
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_complaints_unique_order_id
  ON public.order_complaints(order_id);

-- ----------------------------------------------------------------------------
-- support_tickets: tighten insert policy to authenticated owner of the row
-- ----------------------------------------------------------------------------

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can insert support tickets" ON public.support_tickets;
DROP POLICY IF EXISTS "Authenticated users can insert own support tickets" ON public.support_tickets;

CREATE POLICY "Authenticated users can insert own support tickets"
  ON public.support_tickets
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND customer_id = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can view own support tickets" ON public.support_tickets;
CREATE POLICY "Users can view own support tickets"
  ON public.support_tickets
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() IS NOT NULL
    AND customer_id = auth.uid()::text
  );
