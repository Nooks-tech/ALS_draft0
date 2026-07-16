-- Atomic + idempotent points REFUND/credit, mirroring redeem_loyalty_points.
--
-- WHY: every reward-refund credit path (handleUnredeemMilestone's finishRefund,
-- restoreStampMilestonesForRefund's two passes) previously did the ledger-row
-- insert and the loyalty_points balance change as TWO separate writes. A hard
-- process kill in the window between them left the flow split:
--   * credit-then-ledger (restore 1st pass): retry re-credits -> DOUBLE CREDIT.
--   * ledger-then-credit (unredeem): retry sees the ledger 23505 and skips the
--     credit -> SILENT LOSS (customer never gets points back).
-- redeem_loyalty_points already solved this for the DEDUCT direction by doing
-- both in ONE function (one transaction): ledger row FIRST with ON CONFLICT DO
-- NOTHING on the partial unique index idx_loyalty_tx_points_redeem_per_order,
-- then move the balance only if the insert was new. This is the CREDIT twin.
--
-- Idempotency key = p_order_id (must be UNIQUE per refund instance). A refund is
-- recorded as a POSITIVE-points type='redeem' loyalty_type='points' row (the
-- same convention finishRefund already used), so it falls under the same
-- partial unique index and dedups atomically. lifetime_points is NEVER touched
-- (a refund is a reversal, not earning).
--
-- Hardened per Phase A: SET search_path='' + schema-qualified; EXECUTE to
-- service_role only. Reversible: DROP at the bottom comment.

CREATE OR REPLACE FUNCTION public.refund_loyalty_points(
  p_customer_id    text,
  p_merchant_id    text,
  p_points         numeric,
  p_order_id       text,
  p_reference_type text,
  p_reference_id   text,
  p_source         text DEFAULT 'app',
  p_description    text DEFAULT NULL,
  p_metadata       jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_current numeric;
  v_new     numeric;
  v_tx_id   uuid;
BEGIN
  IF p_points IS NULL OR p_points <= 0 THEN
    RAISE EXCEPTION 'refund points must be positive';
  END IF;
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'refund requires a unique p_order_id for idempotency';
  END IF;

  -- Lock the balance row (if it exists) so concurrent refunds serialize.
  SELECT points INTO v_current
    FROM public.loyalty_points
    WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
    FOR UPDATE;

  -- Fast idempotency check: already refunded under this exact order_id?
  SELECT id INTO v_tx_id
    FROM public.loyalty_transactions
    WHERE merchant_id = p_merchant_id AND customer_id = p_customer_id
      AND order_id = p_order_id AND type = 'redeem' AND loyalty_type = 'points'
    ORDER BY created_at ASC
    LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'duplicate', 'new_balance', COALESCE(v_current, 0));
  END IF;

  -- Ledger row FIRST (idempotency marker). A refund = positive-points 'redeem'.
  INSERT INTO public.loyalty_transactions
    (customer_id, merchant_id, order_id, type, loyalty_type, points,
     reference_type, reference_id, source, description, metadata)
  VALUES
    (p_customer_id, p_merchant_id, p_order_id, 'redeem', 'points', p_points,
     p_reference_type, p_reference_id, COALESCE(p_source, 'app'), p_description,
     COALESCE(p_metadata, '{}'::jsonb))
  ON CONFLICT (merchant_id, customer_id, order_id)
    WHERE type = 'redeem' AND loyalty_type = 'points' AND order_id IS NOT NULL
    DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    -- Lost a concurrent race for this order_id: the winner credited it. No-op.
    SELECT points INTO v_current
      FROM public.loyalty_points
      WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id;
    RETURN jsonb_build_object('status', 'duplicate', 'new_balance', COALESCE(v_current, 0));
  END IF;

  -- Fresh ledger row -> credit the balance in the SAME transaction. Create the
  -- balance row if this is the customer's first-ever points touch. Never move
  -- lifetime_points (a refund is not earning).
  INSERT INTO public.loyalty_points AS lp (customer_id, merchant_id, points, lifetime_points, config_version)
  VALUES (p_customer_id, p_merchant_id, p_points, 0, 1)
  ON CONFLICT (customer_id, merchant_id) DO UPDATE
    SET points = lp.points + p_points, updated_at = now()
  RETURNING lp.points INTO v_new;

  RETURN jsonb_build_object('status', 'ok', 'new_balance', v_new, 'transaction_id', v_tx_id);
END
$function$;

REVOKE ALL ON FUNCTION public.refund_loyalty_points(text, text, numeric, text, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_loyalty_points(text, text, numeric, text, text, text, text, text, jsonb)
  TO service_role;

-- ROLLBACK: DROP FUNCTION IF EXISTS public.refund_loyalty_points(text, text, numeric, text, text, text, text, text, jsonb);
