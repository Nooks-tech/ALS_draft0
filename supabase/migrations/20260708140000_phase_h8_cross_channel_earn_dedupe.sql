-- Phase H8 — cross-channel double-earn dedup (audit 2026-07-07: H8)
-- Applied to the live DB separately by the main session; this file is the
-- version-controlled record of the same DDL.
--
-- One physical purchase can earn loyalty twice because the app channel keys
-- earns on customer_orders.id (order-<ts>/web-<uuid>) while the kiosk/branch
-- channel keys on branch-sale:<foodics-order-uuid>. The bridge is the Foodics
-- order uuid (customer_orders.foodics_order_id). This adds a nullable
-- foodics_order_ref column to the loyalty ledger plus a partial unique index
-- that atomically arbitrates the race once the server writes the column.
--
-- The index is DORMANT until CROSS_CHANNEL_EARN_GUARD=enforce: in 'off' and
-- 'shadow' modes the server never writes foodics_order_ref, so every row has
-- NULL there and the partial index matches nothing. Safe to apply any time.

ALTER TABLE public.loyalty_transactions ADD COLUMN IF NOT EXISTS foodics_order_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_foodics_purchase_earn_unique
  ON public.loyalty_transactions (merchant_id, customer_id, foodics_order_ref, loyalty_type)
  WHERE type='earn' AND foodics_order_ref IS NOT NULL AND source IN ('app','branch');

-- ROLLBACK:
--   Set CROSS_CHANNEL_EARN_GUARD=off (or unset for 'shadow') and redeploy/restart
--   the API so nothing writes the column, then:
--   DROP INDEX IF EXISTS public.idx_loyalty_foodics_purchase_earn_unique;
--   ALTER TABLE public.loyalty_transactions DROP COLUMN IF EXISTS foodics_order_ref;
