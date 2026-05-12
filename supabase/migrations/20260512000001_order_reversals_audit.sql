-- Audit table for order cancellation/reversal flows. One row per
-- order_id summarising what each reversal source did:
--   - card portion: void | refund | failed | not_required | skipped
--   - wallet portion: credited amount (if any)
--   - cashback portion: restored amount (if any)
--   - stamps portion: restored stamps + milestones cleared (if any)
--
-- The unique (order_id) constraint enforces "one reversal record per
-- order" — replays UPSERT into the same row instead of accumulating
-- duplicates. Sub-action idempotency lives in each source's own table
-- (loyalty_transactions for cashback/stamps, customer_wallet_transactions
-- for wallet, customer_orders.status='Cancelled' for the whole flow),
-- so re-running a cancel cannot double-rewind regardless of audit-row
-- shape.

CREATE TABLE IF NOT EXISTS public.order_reversals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id text NOT NULL UNIQUE,
  cancelled_by text NOT NULL CHECK (cancelled_by IN ('merchant', 'system', 'customer')),
  reason text,
  -- The refund_method that landed on customer_orders.refund_method.
  -- 'card' = money went back to card, 'wallet' = wallet credit fired,
  -- 'none' = nothing was owed (payment never charged).
  refund_method text NOT NULL CHECK (refund_method IN ('card', 'wallet', 'none')),
  refunded_sar numeric NOT NULL DEFAULT 0,
  -- Full breakdown: { card: {method, amountSar}, wallet: {amountSar},
  -- cashback: {amountSar, alreadyRestored}, stamps: {count, milestones,
  -- alreadyRestored} }. Keys omitted when not applicable. JSONB so ops
  -- can run rich queries (e.g. "all cashback restorations in May" via
  -- breakdown -> 'cashback' IS NOT NULL).
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_reversals_created_at
  ON public.order_reversals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_reversals_method
  ON public.order_reversals(refund_method);

-- RLS: read-only for the order's customer (so the customer app can
-- display "refunded to: card 20 SAR + wallet 12 SAR + cashback 5 SAR
-- + 8 stamps restored" on the cancelled-order screen). Writes are
-- server-side only via service-role key.
ALTER TABLE public.order_reversals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Customers can read their own reversals" ON public.order_reversals;
CREATE POLICY "Customers can read their own reversals"
  ON public.order_reversals FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.customer_orders o
      WHERE o.id = order_reversals.order_id
        AND o.customer_id = auth.uid()::text
    )
  );
