-- Fix: redeem_loyalty_cashback inserted p_metadata verbatim, but callers
-- (orders.ts /commit cashback redemption, loyalty.ts) never pass it, so it
-- was NULL and violated loyalty_transactions.metadata NOT NULL -> the RPC
-- errored and cashback checkout returned 503 (order could not complete).
-- COALESCE p_metadata to {} (same fix already applied to refund_loyalty_points
-- and credit_customer_cashback). Confirmed live on Frankfurt 2026-07-16.

CREATE OR REPLACE FUNCTION public.redeem_loyalty_cashback(p_customer_id text, p_merchant_id text, p_amount_sar numeric, p_order_id text, p_reference_type text, p_reference_id text, p_source text, p_description text, p_config_version integer DEFAULT NULL::integer, p_branch_id uuid DEFAULT NULL::uuid, p_actor_user_id text DEFAULT NULL::text, p_actor_role text DEFAULT NULL::text, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_balance        numeric;
  v_new            numeric;
  v_config_version integer;
  v_tx_id          uuid;
BEGIN
  IF p_amount_sar IS NULL OR p_amount_sar <= 0 THEN
    RAISE EXCEPTION 'redeem cashback amount must be positive';
  END IF;

  -- Resolve + lock the active cashback balance row. The app treats the highest
  -- config_version as the live balance (loyaltyExpiration.ts, redeem-cashback
  -- route); honour an explicit p_config_version when the caller passes one.
  IF p_config_version IS NULL THEN
    SELECT balance_sar, config_version INTO v_balance, v_config_version
      FROM public.loyalty_cashback_balances
      WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
      ORDER BY config_version DESC
      LIMIT 1
      FOR UPDATE;
  ELSE
    SELECT balance_sar, config_version INTO v_balance, v_config_version
      FROM public.loyalty_cashback_balances
      WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
        AND config_version = p_config_version
      FOR UPDATE;
  END IF;

  -- Idempotency: a cashback redeem already booked for this order?
  IF p_order_id IS NOT NULL THEN
    SELECT id INTO v_tx_id
      FROM public.loyalty_transactions
      WHERE merchant_id = p_merchant_id AND customer_id = p_customer_id
        AND order_id = p_order_id AND type = 'redeem' AND loyalty_type = 'cashback'
      ORDER BY created_at ASC
      LIMIT 1;
    IF v_tx_id IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'duplicate', 'new_balance_sar', COALESCE(v_balance, 0));
    END IF;
  END IF;

  IF v_balance IS NULL OR v_balance < p_amount_sar THEN
    RETURN jsonb_build_object('status', 'insufficient', 'new_balance_sar', COALESCE(v_balance, 0));
  END IF;

  v_new := round(v_balance - p_amount_sar, 2);

  INSERT INTO public.loyalty_transactions
    (customer_id, merchant_id, order_id, type, loyalty_type, points, amount_sar,
     reference_type, reference_id, source, description, config_version,
     branch_id, actor_user_id, actor_role, metadata)
  VALUES
    (p_customer_id, p_merchant_id, p_order_id, 'redeem', 'cashback', 0, -p_amount_sar,
     p_reference_type, p_reference_id, COALESCE(p_source, 'app'), p_description, v_config_version,
     p_branch_id, p_actor_user_id, p_actor_role, COALESCE(p_metadata, '{}'::jsonb))
  ON CONFLICT (merchant_id, customer_id, order_id)
    WHERE type = 'redeem' AND loyalty_type = 'cashback' AND order_id IS NOT NULL
    DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    -- lost a concurrent race for this order: re-read balance, decrement nothing
    SELECT balance_sar INTO v_balance
      FROM public.loyalty_cashback_balances
      WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
        AND config_version = v_config_version;
    RETURN jsonb_build_object('status', 'duplicate', 'new_balance_sar', COALESCE(v_balance, 0));
  END IF;

  UPDATE public.loyalty_cashback_balances
    SET balance_sar = v_new, updated_at = now()
    WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
      AND config_version = v_config_version;

  RETURN jsonb_build_object('status', 'ok', 'new_balance_sar', v_new);
END
$function$

