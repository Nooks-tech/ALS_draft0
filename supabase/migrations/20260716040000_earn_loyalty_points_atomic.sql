-- Atomic + idempotent points EARN, mirroring refund_loyalty_points /
-- redeem_loyalty_points.
--
-- WHY: earnPoints() in server/routes/loyalty.ts previously did the loyalty
-- ledger INSERT and the balance credit (increment_loyalty_points RPC) as TWO
-- separate writes: ledger row first (idempotency marker on the partial
-- unique indexes), then the increment RPC. A hard process kill in the
-- window between those two writes leaves the earn split: the ledger row
-- exists, but the balance was never credited. Every retry after that then
-- hits the ledger row on the SELECT idempotency fast-path (or the 23505 on
-- a re-insert) and returns pointsEarned: 0 without ever crediting — the
-- customer SILENTLY LOSES the points forever. This is the earn-direction
-- twin of the crash window refund_loyalty_points closed for credits and
-- redeem_loyalty_points closed for deducts: do the ledger insert and the
-- balance credit in ONE function, i.e. one DB transaction, so a crash
-- anywhere in between rolls back cleanly and a retry either sees nothing
-- (safe to redo) or sees a fully-committed earn (safe to dedup).
--
-- Idempotency key = p_order_id (must be unique per earn instance, exactly
-- as the app already required before calling earnPoints). The ledger insert
-- is additionally wrapped in its own BEGIN/EXCEPTION sub-block rather than
-- relying on a single ON CONFLICT target, because THREE different partial
-- unique indexes can independently fire on an earn insert depending on
-- source/order_id/foodics_order_ref combination:
--   idx_loyalty_transactions_app_earn_unique
--   idx_loyalty_normal_earn_unique
--   idx_loyalty_foodics_purchase_earn_unique
-- A single ON CONFLICT <target> DO NOTHING only catches violations against
-- the ONE index it names — a violation on a DIFFERENT index still raises an
-- uncaught 23505 and aborts the function. Catching unique_violation
-- generically handles a conflict on ANY of the three, which is what
-- "already earned for this order, no matter which index caught it" means.
--
-- Points earned CAN legitimately be zero (production has a real 0-point
-- earn row from a $0 order), so p_points = 0 is accepted; only NULL or
-- negative is rejected.
--
-- increment_loyalty_points is intentionally left untouched — its exact body
-- is pinned by the Phase A attestation snapshot and it has other callers in
-- the nooksweb repo. This function replicates its balance-credit semantics
-- inline instead of calling it, since both the ledger insert and the
-- balance credit must happen in the SAME transaction here.
--
-- Hardened per Phase A: SET search_path='' + schema-qualified; EXECUTE to
-- service_role only. Reversible: DROP at the bottom comment.

CREATE OR REPLACE FUNCTION public.earn_loyalty_points(
  p_customer_id       text,
  p_merchant_id       text,
  p_points            numeric,
  p_order_id          text,
  p_description       text        DEFAULT NULL,
  p_expires_at        timestamptz DEFAULT NULL,
  p_program_id        uuid        DEFAULT NULL,
  p_branch_id         uuid        DEFAULT NULL,
  p_source            text        DEFAULT 'app',
  p_actor_user_id     text        DEFAULT NULL,
  p_actor_role        text        DEFAULT NULL,
  p_reference_type    text        DEFAULT NULL,
  p_reference_id      text        DEFAULT NULL,
  p_foodics_order_ref text        DEFAULT NULL,
  p_config_version    integer     DEFAULT 1,
  p_metadata          jsonb       DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_current  numeric;
  v_new      numeric;
  v_lifetime numeric;
  v_tx_id    uuid;
BEGIN
  IF p_points IS NULL OR p_points < 0 THEN
    RAISE EXCEPTION 'earn points must be non-negative';
  END IF;
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'earn requires a unique p_order_id for idempotency';
  END IF;

  -- Lock the balance row (if it exists) so concurrent earns serialize.
  SELECT points INTO v_current
    FROM public.loyalty_points
    WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
    FOR UPDATE;

  -- Fast idempotency check: mirrors idx_loyalty_normal_earn_unique exactly
  -- (not the app's old `points > 0` filter — the narrower index predicate is
  -- strictly safer here: a false 'duplicate' would silently skip a
  -- legitimate earn, whereas a miss just falls through to the INSERT below,
  -- which is caught by the unique_violation handler regardless).
  SELECT id INTO v_tx_id
    FROM public.loyalty_transactions
    WHERE merchant_id = p_merchant_id AND customer_id = p_customer_id
      AND order_id = p_order_id AND type = 'earn' AND loyalty_type = 'points'
      AND description NOT LIKE 'Refunded%' AND description NOT LIKE 'Restored%'
    ORDER BY created_at ASC
    LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'duplicate', 'new_balance', COALESCE(v_current, 0), 'points_earned', 0);
  END IF;

  -- Ledger row (idempotency marker). Wrapped in its own sub-block because
  -- any of the three partial unique indexes described above can fire; catch
  -- unique_violation generically so all three dedup cleanly instead of only
  -- the one an ON CONFLICT target would name.
  BEGIN
    INSERT INTO public.loyalty_transactions
      (customer_id, merchant_id, order_id, type, loyalty_type, points,
       description, expires_at, program_id, branch_id, source,
       actor_user_id, actor_role, reference_type, reference_id,
       foodics_order_ref, metadata)
    VALUES
      (p_customer_id, p_merchant_id, p_order_id, 'earn', 'points', p_points,
       p_description, p_expires_at, p_program_id, p_branch_id, COALESCE(p_source, 'app'),
       p_actor_user_id, p_actor_role, p_reference_type, p_reference_id,
       p_foodics_order_ref, COALESCE(p_metadata, '{}'::jsonb))
    RETURNING id INTO v_tx_id;
  EXCEPTION WHEN unique_violation THEN
    -- Race-loser / retry against ANY of the three earn indexes — already
    -- earned for this order. No-op; return the current balance.
    SELECT points INTO v_current
      FROM public.loyalty_points
      WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id;
    RETURN jsonb_build_object('status', 'duplicate', 'new_balance', COALESCE(v_current, 0), 'points_earned', 0);
  END;

  -- Won the slot — credit the balance in the SAME transaction, replicating
  -- increment_loyalty_points' semantics exactly (including: never move
  -- config_version on conflict, only bump lifetime_points when p_points > 0).
  INSERT INTO public.loyalty_points AS lp (customer_id, merchant_id, points, lifetime_points, config_version)
  VALUES (p_customer_id, p_merchant_id, GREATEST(p_points, 0), GREATEST(p_points, 0), COALESCE(p_config_version, 1))
  ON CONFLICT (customer_id, merchant_id) DO UPDATE
    SET points = lp.points + p_points,
        lifetime_points = CASE WHEN p_points > 0 THEN lp.lifetime_points + p_points ELSE lp.lifetime_points END,
        updated_at = pg_catalog.now()
  RETURNING lp.points, lp.lifetime_points INTO v_new, v_lifetime;

  RETURN jsonb_build_object(
    'status', 'ok',
    'new_balance', v_new,
    'lifetime_points', v_lifetime,
    'transaction_id', v_tx_id,
    'points_earned', p_points
  );
END
$function$;

REVOKE ALL ON FUNCTION public.earn_loyalty_points(text, text, numeric, text, text, timestamptz, uuid, uuid, text, text, text, text, text, text, integer, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.earn_loyalty_points(text, text, numeric, text, text, timestamptz, uuid, uuid, text, text, text, text, text, text, integer, jsonb)
  TO service_role;

-- ROLLBACK: DROP FUNCTION IF EXISTS public.earn_loyalty_points(text, text, numeric, text, text, timestamptz, uuid, uuid, text, text, text, text, text, text, integer, jsonb);
