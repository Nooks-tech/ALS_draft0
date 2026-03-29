-- ============================================================================
-- REMAINING GAPS — Phase 2 Migration
-- Drive-thru order type, car details, loyalty expiry warnings
-- Safe to run multiple times (IF NOT EXISTS / DO $$ guards)
-- ============================================================================


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  1. Widen customer_orders.order_type for drive-thru                    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- The CHECK constraint name varies; drop any existing one safely
DO $$
BEGIN
  -- Try common constraint names
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_orders_order_type_check' AND conrelid = 'public.customer_orders'::regclass) THEN
    ALTER TABLE public.customer_orders DROP CONSTRAINT customer_orders_order_type_check;
  END IF;
END $$;

-- Re-add with drivethru included (no-op if constraint doesn't exist — safe)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_orders_order_type_check'
    AND conrelid = 'public.customer_orders'::regclass
  ) THEN
    ALTER TABLE public.customer_orders
      ADD CONSTRAINT customer_orders_order_type_check
      CHECK (order_type IN ('delivery', 'pickup', 'drivethru'));
  END IF;
END $$;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  2. Car details for curbside/drive-thru orders                         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.customer_orders
  ADD COLUMN IF NOT EXISTS car_details jsonb;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  3. Loyalty expiry warning flag                                        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.loyalty_transactions
  ADD COLUMN IF NOT EXISTS expiry_warned boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_loyalty_tx_expiry_warn_pending
  ON public.loyalty_transactions(expires_at)
  WHERE expires_at IS NOT NULL AND expired = false AND expiry_warned = false AND type = 'earn';
