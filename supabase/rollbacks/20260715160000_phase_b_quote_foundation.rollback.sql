-- Approval-gated rollback for 20260715160000_phase_b_quote_foundation.sql.
--
-- The rollback is intentionally data-safe: once any quote, attempt, top-up,
-- observation, or normalized order row exists, it refuses to drop the new
-- economic history. In normal production rollback, revert application code
-- and leave this additive schema in place.

BEGIN;

DO $phase_b_rollback_preflight$
DECLARE
  expected_table text;
  populated_table text;
  row_exists boolean;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('phase_b_quote_foundation_schema_v1', 0)
  );

  FOREACH expected_table IN ARRAY ARRAY[
    'checkout_quotes', 'checkout_quote_lines', 'checkout_quote_options',
    'checkout_quote_adjustments', 'payment_attempts', 'payment_attempt_components',
    'payment_attempt_observations', 'wallet_topup_intents', 'provider_object_bindings', 'order_lines',
    'order_line_options'
  ]
  LOOP
    IF pg_catalog.to_regclass('public.' || expected_table) IS NULL THEN
      RAISE EXCEPTION 'Phase B rollback preflight: missing public.%', expected_table;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'promo_codes'
       AND column_name = 'updated_at'
       AND data_type = 'timestamp with time zone'
       AND is_nullable = 'NO'
  )
     OR pg_catalog.to_regprocedure('public.touch_promo_codes_updated_at()') IS NULL
     OR pg_catalog.to_regclass('public.phase_b_branch_mappings_id_merchant_unique') IS NULL
     OR pg_catalog.to_regclass('public.phase_b_products_id_merchant_unique') IS NULL
     OR pg_catalog.to_regclass('public.phase_b_merchant_qr_codes_id_merchant_branch_unique') IS NULL THEN
    RAISE EXCEPTION 'Phase B rollback preflight: owned foundation object drift';
  END IF;

  -- Retain these locks through every emptiness/link check and all following
  -- drops. No concurrent insert or customer_orders link can slip between the
  -- rollback safety decision and destructive DDL.
  LOCK TABLE
    public.customer_orders,
    public.checkout_quotes,
    public.checkout_quote_lines,
    public.checkout_quote_options,
    public.checkout_quote_adjustments,
    public.payment_attempts,
    public.payment_attempt_components,
    public.payment_attempt_observations,
    public.wallet_topup_intents,
    public.provider_object_bindings,
    public.order_lines,
    public.order_line_options,
    public.promo_codes
  IN ACCESS EXCLUSIVE MODE;

  FOREACH populated_table IN ARRAY ARRAY[
    'checkout_quote_options', 'checkout_quote_lines', 'checkout_quote_adjustments',
    'payment_attempt_observations', 'payment_attempt_components', 'payment_attempts',
    'wallet_topup_intents', 'provider_object_bindings',
    'order_line_options', 'order_lines', 'checkout_quotes'
  ]
  LOOP
    EXECUTE pg_catalog.format(
      'SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)',
      populated_table
    ) INTO row_exists;
    IF row_exists THEN
      RAISE EXCEPTION
        'Phase B rollback refused: public.% contains durable economic rows',
        populated_table;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM public.customer_orders
     WHERE checkout_quote_id IS NOT NULL
        OR payment_attempt_id IS NOT NULL
        OR total_halala IS NOT NULL
        OR currency IS NOT NULL
        OR collection_state IS NOT NULL
        OR delivery_latitude IS NOT NULL
        OR delivery_longitude IS NOT NULL
        OR delivery_zone_config_hash IS NOT NULL
        OR fulfillment_authorized_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Phase B rollback refused: customer_orders contains Phase B link data';
  END IF;
END
$phase_b_rollback_preflight$;

DROP TRIGGER customer_orders_quote_link_guard ON public.customer_orders;

DROP INDEX public.customer_orders_payment_attempt_unique;
DROP INDEX public.customer_orders_checkout_quote_unique;

ALTER TABLE public.customer_orders
  DROP CONSTRAINT customer_orders_quote_link_complete,
  DROP CONSTRAINT customer_orders_delivery_location_valid,
  DROP CONSTRAINT customer_orders_collection_state_valid,
  DROP CONSTRAINT customer_orders_currency_sar,
  DROP CONSTRAINT customer_orders_total_halala_nonnegative,
  DROP CONSTRAINT customer_orders_payment_attempt_fk,
  DROP CONSTRAINT customer_orders_checkout_quote_fk,
  DROP COLUMN fulfillment_authorized_at,
  DROP COLUMN delivery_zone_config_hash,
  DROP COLUMN delivery_longitude,
  DROP COLUMN delivery_latitude,
  DROP COLUMN collection_state,
  DROP COLUMN currency,
  DROP COLUMN total_halala,
  DROP COLUMN payment_attempt_id,
  DROP COLUMN checkout_quote_id;

DROP TABLE public.order_line_options;
DROP TABLE public.order_lines;
DROP TABLE public.payment_attempt_observations;
DROP TABLE public.payment_attempt_components;
DROP TABLE public.wallet_topup_intents;
DROP TABLE public.payment_attempts;
DROP TABLE public.provider_object_bindings;
DROP TABLE public.checkout_quote_adjustments;
DROP TABLE public.checkout_quote_options;
DROP TABLE public.checkout_quote_lines;
DROP TABLE public.checkout_quotes;

DROP FUNCTION public.materialize_quote_order_lines(text, uuid);
DROP FUNCTION public.create_payment_attempt(jsonb, jsonb);
DROP FUNCTION public.persist_checkout_quote(jsonb, jsonb, jsonb);
DROP FUNCTION public.enforce_quote_backed_order_link();
DROP FUNCTION public.enforce_wallet_topup_transition();
DROP FUNCTION public.enforce_attempt_component_transition();
DROP FUNCTION public.enforce_payment_attempt_insert();
DROP FUNCTION public.enforce_payment_attempt_transition();
DROP FUNCTION public.enforce_checkout_quote_transition();
DROP FUNCTION public.enforce_phase_b_provider_bindings();
DROP FUNCTION public.bind_phase_b_provider_object(text, text, text, text, uuid);
DROP FUNCTION public.reject_phase_b_immutable_mutation();

DROP INDEX public.phase_b_merchant_qr_codes_id_merchant_branch_unique;
DROP INDEX public.phase_b_products_id_merchant_unique;
DROP INDEX public.phase_b_branch_mappings_id_merchant_unique;

DROP TRIGGER promo_codes_touch_updated_at ON public.promo_codes;
DROP FUNCTION public.touch_promo_codes_updated_at();
ALTER TABLE public.promo_codes DROP COLUMN updated_at;

DO $phase_b_rollback_postconditions$
DECLARE
  removed_table text;
  removed_column text;
BEGIN
  FOREACH removed_table IN ARRAY ARRAY[
    'checkout_quotes', 'checkout_quote_lines', 'checkout_quote_options',
    'checkout_quote_adjustments', 'payment_attempts', 'payment_attempt_components',
    'payment_attempt_observations', 'wallet_topup_intents', 'provider_object_bindings', 'order_lines',
    'order_line_options'
  ]
  LOOP
    IF pg_catalog.to_regclass('public.' || removed_table) IS NOT NULL THEN
      RAISE EXCEPTION 'Phase B rollback postcondition: public.% still exists', removed_table;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'promo_codes'
       AND column_name = 'updated_at'
  )
     OR pg_catalog.to_regprocedure('public.create_payment_attempt(jsonb,jsonb)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.materialize_quote_order_lines(text,uuid)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.touch_promo_codes_updated_at()') IS NOT NULL
     OR pg_catalog.to_regclass('public.phase_b_branch_mappings_id_merchant_unique') IS NOT NULL
     OR pg_catalog.to_regclass('public.phase_b_products_id_merchant_unique') IS NOT NULL
     OR pg_catalog.to_regclass('public.phase_b_merchant_qr_codes_id_merchant_branch_unique') IS NOT NULL THEN
    RAISE EXCEPTION 'Phase B rollback postcondition: owned foundation objects remain';
  END IF;

  FOREACH removed_column IN ARRAY ARRAY[
    'checkout_quote_id', 'payment_attempt_id', 'total_halala', 'currency',
    'collection_state', 'delivery_latitude', 'delivery_longitude',
    'delivery_zone_config_hash', 'fulfillment_authorized_at'
  ]
  LOOP
    IF EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'customer_orders'
         AND column_name = removed_column
    ) THEN
      RAISE EXCEPTION 'Phase B rollback postcondition: customer_orders.% remains', removed_column;
    END IF;
  END LOOP;
END
$phase_b_rollback_postconditions$;

COMMIT;
