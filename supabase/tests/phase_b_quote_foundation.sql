-- Read-only catalog/ACL verification for the Phase B quote foundation.
-- Run only after 20260715160000_phase_b_quote_foundation.sql on an approved
-- database or disposable local fixture.

\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

DO $phase_b_catalog_test$
DECLARE
  expected_table text;
  expected_column text;
  expected_constraint text;
  expected_trigger text;
  expected_function text;
  rpc_signature text;
  function_oid oid;
  function_config text[];
BEGIN
  FOREACH expected_table IN ARRAY ARRAY[
    'checkout_quotes', 'checkout_quote_lines', 'checkout_quote_options',
    'checkout_quote_adjustments', 'payment_attempts', 'payment_attempt_components',
    'payment_attempt_observations', 'wallet_topup_intents', 'provider_object_bindings', 'order_lines',
    'order_line_options'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS c
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = expected_table
         AND c.relkind IN ('r', 'p')
         AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'Phase B catalog test: public.% missing or RLS disabled', expected_table;
    END IF;

    IF pg_catalog.has_table_privilege('anon', 'public.' || expected_table, 'SELECT,INSERT,UPDATE,DELETE')
       OR pg_catalog.has_table_privilege('authenticated', 'public.' || expected_table, 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'Phase B catalog test: untrusted ACL on public.%', expected_table;
    END IF;
  END LOOP;

  -- Quote and normalized-order graphs are RPC-write-only. service_role may
  -- read the immutable snapshots but cannot create partial graphs directly.
  FOREACH expected_table IN ARRAY ARRAY[
    'checkout_quotes', 'checkout_quote_lines', 'checkout_quote_options',
    'checkout_quote_adjustments', 'provider_object_bindings', 'order_lines', 'order_line_options'
  ]
  LOOP
    IF NOT pg_catalog.has_table_privilege('service_role', 'public.' || expected_table, 'SELECT')
       OR pg_catalog.has_table_privilege('service_role', 'public.' || expected_table, 'INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'Phase B catalog test: RPC-only service ACL drift on public.%', expected_table;
    END IF;
  END LOOP;

  IF pg_catalog.has_table_privilege('service_role', 'public.payment_attempts', 'INSERT')
     OR pg_catalog.has_table_privilege('service_role', 'public.payment_attempt_components', 'INSERT')
     OR NOT pg_catalog.has_table_privilege('service_role', 'public.payment_attempts', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('service_role', 'public.payment_attempts', 'UPDATE')
     OR NOT pg_catalog.has_table_privilege('service_role', 'public.payment_attempt_components', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('service_role', 'public.payment_attempt_components', 'UPDATE') THEN
    RAISE EXCEPTION 'Phase B catalog test: attempt graphs are not RPC-create/update-only';
  END IF;

  FOREACH expected_column IN ARRAY ARRAY[
    'checkout_quote_id', 'payment_attempt_id', 'total_halala', 'currency',
    'collection_state', 'delivery_latitude', 'delivery_longitude',
    'delivery_zone_config_hash', 'fulfillment_authorized_at'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'customer_orders'
         AND column_name = expected_column
         AND is_nullable = 'YES'
    ) THEN
      RAISE EXCEPTION 'Phase B catalog test: nullable customer_orders.% missing', expected_column;
    END IF;
  END LOOP;

  function_oid := pg_catalog.to_regprocedure('public.enforce_payment_attempt_transition()');
  IF function_oid IS NULL
     OR pg_catalog.strpos(pg_catalog.pg_get_functiondef(function_oid), 'observed_metadata_nonce = NEW.metadata_nonce') = 0
     OR pg_catalog.strpos(pg_catalog.pg_get_functiondef(function_oid), 'observed_amount_halala = NEW.amount_halala') = 0
     OR pg_catalog.strpos(pg_catalog.pg_get_functiondef(function_oid), 'observed_currency = NEW.currency') = 0
     OR pg_catalog.strpos(pg_catalog.pg_get_functiondef(function_oid), 'provider_object_id = NEW.provider_payment_id') = 0 THEN
    RAISE EXCEPTION 'Phase B catalog test: Moyasar capture observation binding is missing';
  END IF;

  -- 2026-07-15 audit fix: the moyasar-only capture guard above must not be
  -- the ONLY gate on 'captured' — 'mixed' attempts need their own explicit
  -- refusal (per-component settlement evidence isn't implemented yet), or a
  -- bare webhook UPDATE could move a mixed attempt to captured with zero
  -- proof. Assert the refusal text is present and it appears BEFORE the
  -- moyasar-only guard so it can't be short-circuited by it.
  IF function_oid IS NULL
     OR pg_catalog.strpos(pg_catalog.pg_get_functiondef(function_oid), 'per-component settlement evidence') = 0
     OR pg_catalog.strpos(pg_catalog.pg_get_functiondef(function_oid), 'NEW.provider = ''mixed''') = 0
     OR pg_catalog.strpos(pg_catalog.pg_get_functiondef(function_oid), 'NEW.provider = ''mixed''')
        > pg_catalog.strpos(pg_catalog.pg_get_functiondef(function_oid), 'NEW.provider = ''moyasar''') THEN
    RAISE EXCEPTION 'Phase B catalog test: mixed-provider capture refusal is missing or ordered after the moyasar guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'promo_codes'
       AND column_name = 'updated_at'
       AND data_type = 'timestamp with time zone'
       AND is_nullable = 'NO'
       AND column_default = 'clock_timestamp()'
  ) THEN
    RAISE EXCEPTION 'Phase B catalog test: promo_codes.updated_at foundation drift';
  END IF;

  FOREACH expected_column IN ARRAY ARRAY[
    'base_total_halala', 'modifier_total_halala'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'checkout_quote_lines'
         AND column_name = expected_column
         AND data_type = 'bigint'
         AND is_nullable = 'NO'
    ) THEN
      RAISE EXCEPTION 'Phase B catalog test: checkout_quote_lines.% missing', expected_column;
    END IF;
  END LOOP;

  FOREACH expected_constraint IN ARRAY ARRAY[
    'checkout_quotes_identity_xor',
    'checkout_quotes_total_exact',
    'checkout_quotes_delivery_binding_exact',
    'checkout_quotes_idempotency_unique',
    'checkout_quote_lines_quantity_bounded',
    'checkout_quote_lines_amounts_valid',
    'checkout_quote_lines_quote_merchant_fk',
    'checkout_quote_lines_product_merchant_fk',
    'checkout_quote_options_choice_unique',
    'checkout_quotes_branch_merchant_fk',
    'checkout_quotes_qr_merchant_branch_fk',
    'payment_attempts_quote_merchant_fk',
    'payment_attempts_zero_provider_exact',
    'payment_attempts_idempotency_unique',
    'provider_object_bindings_pk',
    'wallet_topup_intents_idempotency_unique',
    'customer_orders_quote_link_complete',
    'customer_orders_delivery_location_valid',
    'order_lines_quote_line_fk',
    'order_lines_quote_source_unique',
    'order_line_options_order_line_fk',
    'order_line_options_quote_option_fk'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS c
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.connamespace
       WHERE n.nspname = 'public'
         AND c.conname = expected_constraint
         AND c.convalidated
    ) THEN
      RAISE EXCEPTION 'Phase B catalog test: validated constraint % missing', expected_constraint;
    END IF;
  END LOOP;

  FOREACH expected_trigger IN ARRAY ARRAY[
    'checkout_quotes_guard',
    'checkout_quote_lines_immutable',
    'checkout_quote_options_immutable',
    'checkout_quote_adjustments_immutable',
    'payment_attempts_guard',
    'payment_attempts_insert_guard',
    'payment_attempts_provider_binding',
    'payment_attempt_components_guard',
    'payment_attempt_observations_immutable',
    'wallet_topup_intents_guard',
    'wallet_topup_intents_provider_binding',
    'provider_object_bindings_immutable',
    'order_lines_immutable',
    'order_line_options_immutable',
    'customer_orders_quote_link_guard',
    'promo_codes_touch_updated_at'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_trigger
       WHERE tgname = expected_trigger
         AND NOT tgisinternal
         AND tgenabled = 'O'
    ) THEN
      RAISE EXCEPTION 'Phase B catalog test: enabled trigger % missing', expected_trigger;
    END IF;
  END LOOP;

  FOREACH rpc_signature IN ARRAY ARRAY[
    'public.persist_checkout_quote(jsonb,jsonb,jsonb)',
    'public.create_payment_attempt(jsonb,jsonb)',
    'public.materialize_quote_order_lines(text,uuid)'
  ]
  LOOP
    function_oid := pg_catalog.to_regprocedure(rpc_signature);
    IF function_oid IS NULL THEN
      RAISE EXCEPTION 'Phase B catalog test: RPC missing: %', rpc_signature;
    END IF;
    SELECT p.proconfig
      INTO function_config
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid = function_oid
       AND p.prosecdef
       AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres';
    IF NOT FOUND OR function_config IS DISTINCT FROM ARRAY['search_path=""']::text[] THEN
      RAISE EXCEPTION 'Phase B catalog test: RPC owner/definer/search_path drift: %', rpc_signature;
    END IF;
    IF EXISTS (
         SELECT 1
           FROM pg_catalog.pg_proc AS p,
                LATERAL pg_catalog.aclexplode(
                  COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
                ) AS acl
          WHERE p.oid = function_oid
            AND acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Phase B catalog test: RPC is not service-role-only: %', rpc_signature;
    END IF;
  END LOOP;

  FOREACH expected_function IN ARRAY ARRAY[
    'public.reject_phase_b_immutable_mutation()',
    'public.touch_promo_codes_updated_at()',
    'public.bind_phase_b_provider_object(text,text,text,text,uuid)',
    'public.enforce_phase_b_provider_bindings()',
    'public.enforce_checkout_quote_transition()',
    'public.enforce_payment_attempt_transition()',
    'public.enforce_payment_attempt_insert()',
    'public.enforce_attempt_component_transition()',
    'public.enforce_wallet_topup_transition()',
    'public.enforce_quote_backed_order_link()'
  ]
  LOOP
    function_oid := pg_catalog.to_regprocedure(expected_function);
    IF function_oid IS NULL
       OR pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Phase B catalog test: trigger helper ACL drift for %', expected_function;
    END IF;
  END LOOP;

  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public' AND indexname = 'payment_attempts_provider_payment_unique'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public' AND indexname = 'payment_attempts_one_active_per_quote'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public' AND indexname = 'phase_b_branch_mappings_id_merchant_unique'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public' AND indexname = 'phase_b_products_id_merchant_unique'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public' AND indexname = 'phase_b_merchant_qr_codes_id_merchant_branch_unique'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public' AND indexname = 'customer_orders_payment_attempt_unique'
     ) THEN
    RAISE EXCEPTION 'Phase B catalog test: one-payment/one-order unique indexes missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger
     WHERE tgname = 'customer_orders_quote_link_guard'
       AND pg_catalog.pg_get_triggerdef(oid) LIKE '%UPDATE OF%'
  ) THEN
    RAISE EXCEPTION 'Phase B catalog test: customer order guard is not all-column';
  END IF;
END
$phase_b_catalog_test$;

SELECT 'phase_b_quote_foundation catalog/ACL checks passed' AS result;
ROLLBACK;
