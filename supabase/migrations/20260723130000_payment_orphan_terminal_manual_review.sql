-- Deterministic orphan failures (for example, a provider payment with no
-- order_id binding) cannot become safe to auto-refund on a later retry.
-- Allow those rows to leave the hot queue as terminal manual review while
-- transient provider/readback ambiguity remains unresolved and retryable.

BEGIN;

ALTER TABLE public.payment_orphan_candidates
  DROP CONSTRAINT IF EXISTS payment_orphan_candidates_resolution_shape;

ALTER TABLE public.payment_orphan_candidates
  ADD COLUMN IF NOT EXISTS processing_owner text,
  ADD COLUMN IF NOT EXISTS processing_token uuid,
  ADD COLUMN IF NOT EXISTS processing_until timestamptz;

ALTER TABLE public.payment_orphan_candidates
  DROP CONSTRAINT IF EXISTS payment_orphan_candidates_processing_owner_check;

ALTER TABLE public.payment_orphan_candidates
  ADD CONSTRAINT payment_orphan_candidates_processing_owner_check CHECK (
    (
      processing_owner IS NULL
      AND processing_token IS NULL
      AND processing_until IS NULL
    )
    OR (
      resolved_at IS NULL
      AND processing_owner IN ('commit', 'sweep')
      AND processing_token IS NOT NULL
      AND processing_until IS NOT NULL
    )
  );

ALTER TABLE public.payment_orphan_candidates
  ADD CONSTRAINT payment_orphan_candidates_resolution_shape CHECK (
    (resolved_at IS NULL AND resolution IS NULL)
    OR (resolved_at IS NULL AND resolution = 'manual_review')
    OR (
      resolved_at IS NOT NULL
      AND resolution IN ('order_found', 'reversed', 'manual_review', 'not_paid')
    )
  );

-- A captured-payment recovery row is created before the full commit request
-- is trusted. Bound the unresolved queue per authenticated customer so random
-- UUID submissions cannot starve real recovery work. The advisory lock makes
-- the count safe across API replicas; retries of an existing payment remain
-- allowed at the cap.
CREATE OR REPLACE FUNCTION public.enforce_payment_orphan_customer_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.resolved_at IS NOT NULL OR NEW.metadata_customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('payment-orphan-customer:' || NEW.metadata_customer_id, 0)
  );
  IF EXISTS (
    SELECT 1
    FROM public.payment_orphan_candidates
    WHERE payment_id = NEW.payment_id
  ) THEN
    RETURN NEW;
  END IF;
  IF (
    SELECT count(*)
    FROM public.payment_orphan_candidates
    WHERE metadata_customer_id = NEW.metadata_customer_id
      AND resolved_at IS NULL
  ) >= 12 THEN
    RAISE EXCEPTION 'too many unresolved payment recovery candidates'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_orphan_customer_cap
  ON public.payment_orphan_candidates;
CREATE TRIGGER payment_orphan_customer_cap
  BEFORE INSERT ON public.payment_orphan_candidates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_orphan_customer_cap();

CREATE INDEX IF NOT EXISTS idx_payment_orphan_candidates_unresolved_customer
  ON public.payment_orphan_candidates (metadata_customer_id)
  WHERE resolved_at IS NULL AND metadata_customer_id IS NOT NULL;

COMMIT;

-- ROLLBACK:
-- ALTER TABLE public.payment_orphan_candidates
--   DROP CONSTRAINT IF EXISTS payment_orphan_candidates_resolution_shape;
-- ALTER TABLE public.payment_orphan_candidates
--   ADD CONSTRAINT payment_orphan_candidates_resolution_shape CHECK (
--     (resolved_at IS NULL AND resolution IS NULL)
--     OR (resolved_at IS NULL AND resolution = 'manual_review')
--     OR (resolved_at IS NOT NULL AND resolution IN ('order_found', 'reversed', 'not_paid'))
--   );
-- DROP TRIGGER IF EXISTS payment_orphan_customer_cap ON public.payment_orphan_candidates;
-- DROP FUNCTION IF EXISTS public.enforce_payment_orphan_customer_cap();
-- DROP INDEX IF EXISTS public.idx_payment_orphan_candidates_unresolved_customer;
-- ALTER TABLE public.payment_orphan_candidates
--   DROP COLUMN IF EXISTS processing_owner,
--   DROP COLUMN IF EXISTS processing_token,
--   DROP COLUMN IF EXISTS processing_until;
