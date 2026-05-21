-- Server-side per-merchant cart + abandoned-cart audit log.
--
-- Pre-fix, the cart lived entirely in the customer app's
-- AsyncStorage (`@als_cart_${merchantScope}_${uid}`). That's already
-- per-merchant on the device, but it has three downsides for the
-- white-label model:
--   (a) Reinstalling the app wipes the cart.
--   (b) There's no way to push the customer back to a forgotten cart
--       from a server-side trigger (the local 1-hour reminder fires
--       only if the app is alive in the background).
--   (c) Merchants can't see abandoned-cart analytics.
--
-- Fix:
--   customer_carts (merchant_id, customer_id) PRIMARY KEY — one
--     active cart per pair. items_jsonb is the source of truth; the
--     client app keeps a local mirror for offline-resilience.
--   abandoned_carts — append-only log written when the cron sweeps
--     a customer_carts row past 1 hour of idle. recovered_* columns
--     are set if the customer eventually places an order, so the
--     dashboard can show recovery rate.
--
-- The cron flow runs once per minute:
--   updated_at < now() - 15m AND notified_at IS NULL
--     → send merchant-branded push, stamp notified_at
--   updated_at < now() - 1h
--     → INSERT into abandoned_carts, DELETE from customer_carts
--
-- The existing 1-hour local-device cart notification
-- (src/utils/cartNotifications.ts) gets removed in the app code
-- because the server now handles the cadence.

CREATE TABLE IF NOT EXISTS public.customer_carts (
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  customer_id text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal_sar numeric(10, 2) NOT NULL DEFAULT 0,
  branch_id uuid,
  order_type text CHECK (order_type IS NULL OR order_type IN ('delivery', 'pickup', 'drivethru')),
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_carts_updated_at
  ON public.customer_carts (updated_at);

CREATE INDEX IF NOT EXISTS idx_customer_carts_notify_window
  ON public.customer_carts (updated_at)
  WHERE notified_at IS NULL;

ALTER TABLE public.customer_carts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own cart" ON public.customer_carts;
CREATE POLICY "Users can view own cart"
  ON public.customer_carts FOR SELECT
  USING (auth.uid()::text = customer_id);

DROP POLICY IF EXISTS "Users can manage own cart" ON public.customer_carts;
CREATE POLICY "Users can manage own cart"
  ON public.customer_carts FOR ALL
  USING (auth.uid()::text = customer_id)
  WITH CHECK (auth.uid()::text = customer_id);

-- ── Abandoned-cart audit log
CREATE TABLE IF NOT EXISTS public.abandoned_carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  customer_id text NOT NULL,
  items jsonb NOT NULL,
  subtotal_sar numeric(10, 2) NOT NULL DEFAULT 0,
  branch_id uuid,
  order_type text,
  cart_created_at timestamptz,
  cart_last_updated_at timestamptz NOT NULL,
  abandoned_at timestamptz NOT NULL DEFAULT now(),
  recovered_at timestamptz,
  recovered_order_id text
);

CREATE INDEX IF NOT EXISTS idx_abandoned_carts_merchant
  ON public.abandoned_carts (merchant_id, abandoned_at DESC);

CREATE INDEX IF NOT EXISTS idx_abandoned_carts_customer
  ON public.abandoned_carts (customer_id, merchant_id);

-- Index unique-ish: most-recent abandoned cart per (merchant, customer)
-- so the recovery sweep can find it efficiently.
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_pair_recent
  ON public.abandoned_carts (merchant_id, customer_id, abandoned_at DESC);

ALTER TABLE public.abandoned_carts ENABLE ROW LEVEL SECURITY;

-- Customers can see their own abandoned-cart history (a "you left
-- items behind" view in the app). No insert/update/delete from
-- customers — only the cron + service-role writers touch this.
DROP POLICY IF EXISTS "Users can view own abandoned carts" ON public.abandoned_carts;
CREATE POLICY "Users can view own abandoned carts"
  ON public.abandoned_carts FOR SELECT
  USING (auth.uid()::text = customer_id);

-- Cart touch trigger keeps updated_at fresh and resets notified_at
-- whenever the customer changes the cart contents. Resetting
-- notified_at lets the 15-minute push fire again after the customer
-- modifies their cart (they came back, started a new idle window).
CREATE OR REPLACE FUNCTION public.tg_customer_carts_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.items IS DISTINCT FROM OLD.items
     OR NEW.subtotal_sar IS DISTINCT FROM OLD.subtotal_sar
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.order_type IS DISTINCT FROM OLD.order_type
  THEN
    NEW.updated_at := now();
    NEW.notified_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_carts_touch ON public.customer_carts;
CREATE TRIGGER trg_customer_carts_touch
  BEFORE UPDATE ON public.customer_carts
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_customer_carts_touch();
