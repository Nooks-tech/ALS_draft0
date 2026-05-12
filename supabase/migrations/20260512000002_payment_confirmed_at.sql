-- Order visibility gate. Adds payment_confirmed_at to customer_orders:
-- set at /commit time AFTER P1's Moyasar payment verification passes
-- (for card orders) or after the wallet debit succeeds (for wallet-only
-- orders). Legacy orphans where the customer's card was charged but
-- our commit never confirmed payment have this column NULL.
--
-- Both fetch paths (customer app's orders tab, merchant dashboard's
-- orders page) filter WHERE payment_confirmed_at IS NOT NULL so
-- unconfirmed orders never appear in either UI. The pg_cron sweep
-- still runs to reverse wallet/cashback/stamps on orphans within
-- ~15 min, but visibility is gated independently — even an unswept
-- orphan won't pollute the merchant's view.
--
-- Backfill: any order not in 'Placed' status was definitely paid
-- (it advanced past Placed via the Foodics webhook chain or was
-- cancelled — either way payment confirmation happened). Set those
-- to COALESCE(updated_at, created_at). 'Placed' orphans stay NULL.

ALTER TABLE public.customer_orders
  ADD COLUMN IF NOT EXISTS payment_confirmed_at timestamptz;

UPDATE public.customer_orders
  SET payment_confirmed_at = COALESCE(updated_at, created_at)
  WHERE payment_confirmed_at IS NULL
    AND status != 'Placed';

CREATE INDEX IF NOT EXISTS idx_customer_orders_payment_confirmed
  ON public.customer_orders(customer_id, merchant_id, payment_confirmed_at)
  WHERE payment_confirmed_at IS NOT NULL;
