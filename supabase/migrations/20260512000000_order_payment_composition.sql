-- Adds payment-composition columns to customer_orders so cancellations
-- can "rewind time" and return every used source (card / wallet /
-- cashback / stamps) to where it came from. Previously only payment_id
-- (card / wallet:* sentinel) and payment_method (single string) were
-- recorded; the actual breakdown across mixed sources lived in side
-- tables (customer_wallet_transactions, loyalty_transactions,
-- loyalty_stamp_redemptions) and had to be reassembled at refund time
-- with no order_id link for stamps. This makes the order row
-- self-describing about how it was paid.
--
-- All columns are nullable with default 0 / null so existing rows are
-- valid. Newly committed orders populate them at /commit time.

ALTER TABLE public.customer_orders
  ADD COLUMN IF NOT EXISTS card_paid_sar numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wallet_paid_sar numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cashback_paid_sar numeric NOT NULL DEFAULT 0,
  -- Array of milestone IDs the customer redeemed at checkout. JSONB so we
  -- can carry the full set without a side table — the customer can
  -- redeem multiple milestones in one order (e.g. "free coffee at 2
  -- stamps" + "free cake at 8 stamps") and we need to restore all of
  -- them on cancel.
  ADD COLUMN IF NOT EXISTS stamp_milestone_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Total stamps consumed = SUM(milestone.stamp_number for each id).
  -- Stored separately so reversal doesn't need to re-read the
  -- milestone rows (they could be edited or deleted by the merchant
  -- after the order was placed).
  ADD COLUMN IF NOT EXISTS stamps_consumed integer NOT NULL DEFAULT 0;

-- Sanity: stamps_consumed must be non-negative. Defensive — UI / API
-- shouldn't send negatives but a CHECK costs us nothing.
ALTER TABLE public.customer_orders
  DROP CONSTRAINT IF EXISTS customer_orders_stamps_consumed_nonneg;
ALTER TABLE public.customer_orders
  ADD CONSTRAINT customer_orders_stamps_consumed_nonneg
  CHECK (stamps_consumed >= 0);
