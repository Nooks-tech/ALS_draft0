-- 20260710110000_foodics_order_id_partial_unique.sql
--
-- LOY-B (2026-07-10) — enforce that one Foodics order backs at most ONE
-- customer_orders row. The existing idx_customer_orders_foodics_order_id index
-- is NON-UNIQUE, so a race between the app final-commit and the kiosk walk-in
-- sync can mint two rows carrying the same foodics_order_id → a claimable
-- duplicate → double loyalty earn. This adds the PARTIAL UNIQUE index that is
-- the atomic backstop behind the app-side cross-channel earn guard.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAFETY — DO NOT RUN BLINDLY. This migration is written to be applied by hand
-- (do NOT auto-run it as part of a batch) and it will FAIL LOUDLY rather than
-- silently if the data is not already clean:
--
--   * The pre-check DO block below raises a descriptive exception if ANY
--     duplicate non-null foodics_order_id value exists. CREATE UNIQUE INDEX
--     does not support a NOT VALID / deferred-validation mode (that is only for
--     table constraints/FKs), so the pre-check is how we surface duplicates as
--     a clear message instead of a raw unique-violation from the index build.
--   * The live audit on 2026-07-10 found 0 duplicate non-null foodics_order_id
--     values, so on prod this pre-check is expected to pass and the index to
--     build cleanly. If it EVER raises, dedupe the offending rows first, then
--     re-apply this file.
--
-- NOTE on kiosk walk-ins: the kiosk path stores foodics_order_id as
-- 'walkin_<uuid>' while the app/branch paths store the bare '<uuid>'. Those two
-- forms are DISTINCT string values and are both allowed to coexist — this index
-- only forbids exact-duplicate ids (the real double-row hazard). The app-side
-- LOY-B guard in server/routes/loyalty.ts matches BOTH forms so a walk-in earn
-- for the same physical purchase is still deduped at the loyalty layer.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT foodics_order_id
    FROM public.customer_orders
    WHERE foodics_order_id IS NOT NULL
    GROUP BY foodics_order_id
    HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to create unique index: % duplicate foodics_order_id value(s) exist in public.customer_orders. Dedupe them, then re-apply this migration.',
      dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_orders_foodics_order_id_unique
  ON public.customer_orders (foodics_order_id)
  WHERE foodics_order_id IS NOT NULL;
