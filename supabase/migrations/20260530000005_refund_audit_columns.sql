-- Phase 3 (#14): payment-state audit hygiene.
-- (1) refunded_at — refund_status alone carried no timestamp, so the refund
--     timeline was unrecoverable for disputes/reconciliation.
ALTER TABLE public.customer_orders ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

-- (2) Constrain refund_status to the known set so a code path can't leave a
--     typo'd / unexpected value (existing values: refunded, voided,
--     not_required, refund_failed, none, null).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_orders_refund_status_valid') THEN
    ALTER TABLE public.customer_orders
      ADD CONSTRAINT customer_orders_refund_status_valid
      CHECK (refund_status IS NULL OR refund_status IN ('refunded','voided','not_required','refund_failed','none','pending'));
  END IF;
END $$;
