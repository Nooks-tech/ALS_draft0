-- Role-boundary checks for persist_checkout_quote. This never persists a row:
-- untrusted roles must fail at EXECUTE, and service_role reaches validation
-- with an intentionally malformed empty quote graph. The transaction rolls back.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

DO $phase_b_rpc_matrix$
DECLARE
  role_name text;
  rpc_call text;
  direct_insert text;
  stacked_message text;
  binding_source uuid := gen_random_uuid();
BEGIN
  IF CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres' THEN
    RAISE EXCEPTION 'Phase B RPC matrix must run as fixture owner postgres';
  END IF;

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']::text[]
  LOOP
    FOREACH rpc_call IN ARRAY ARRAY[
      'SELECT public.persist_checkout_quote(''{}''::jsonb, ''[]''::jsonb, ''[]''::jsonb)',
      'SELECT public.create_payment_attempt(''{}''::jsonb, ''[]''::jsonb)',
      'SELECT public.materialize_quote_order_lines(''missing'', ''00000000-0000-0000-0000-000000000000''::uuid)'
    ]
    LOOP
      BEGIN
        EXECUTE pg_catalog.format('SET LOCAL ROLE %I', role_name);
        EXECUTE rpc_call;
        EXECUTE 'RESET ROLE';
        RAISE EXCEPTION 'Phase B RPC matrix: % unexpectedly executed %', role_name, rpc_call;
      EXCEPTION
        WHEN insufficient_privilege THEN
          EXECUTE 'RESET ROLE';
        WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS stacked_message = MESSAGE_TEXT;
          EXECUTE 'RESET ROLE';
          RAISE EXCEPTION
            'Phase B RPC matrix: % reached RPC body (SQLSTATE %, message %)',
            role_name,
            SQLSTATE,
            stacked_message;
      END;
    END LOOP;
  END LOOP;

  BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
    PERFORM public.persist_checkout_quote('{}'::jsonb, '[]'::jsonb, '[]'::jsonb);
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'Phase B RPC matrix: malformed service request unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS stacked_message = MESSAGE_TEXT;
      EXECUTE 'RESET ROLE';
      RAISE EXCEPTION 'Phase B RPC matrix: service_role could not execute RPC: %', stacked_message;
    WHEN SQLSTATE '22023' THEN
      EXECUTE 'RESET ROLE';
  END;

  -- The two new service-only RPCs must also reach their validation bodies.
  FOREACH rpc_call IN ARRAY ARRAY[
    'SELECT public.create_payment_attempt(''{}''::jsonb, ''[]''::jsonb)',
    'SELECT public.materialize_quote_order_lines(''missing'', ''00000000-0000-0000-0000-000000000000''::uuid)'
  ]
  LOOP
    BEGIN
      EXECUTE 'SET LOCAL ROLE service_role';
      EXECUTE rpc_call;
      EXECUTE 'RESET ROLE';
      RAISE EXCEPTION 'Phase B RPC matrix: malformed service request unexpectedly succeeded: %', rpc_call
        USING ERRCODE = 'ZX001';
    EXCEPTION
      WHEN insufficient_privilege THEN
        GET STACKED DIAGNOSTICS stacked_message = MESSAGE_TEXT;
        EXECUTE 'RESET ROLE';
        RAISE EXCEPTION 'Phase B RPC matrix: service_role could not execute RPC: %', stacked_message;
      WHEN SQLSTATE 'ZX001' THEN
        EXECUTE 'RESET ROLE';
        RAISE;
      WHEN OTHERS THEN
        EXECUTE 'RESET ROLE';
    END;
  END LOOP;

  -- Even service_role cannot bypass the atomic RPC with a direct partial quote
  -- insert. This should fail on ACL before any NOT NULL/check constraint.
  BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
    INSERT INTO public.checkout_quotes DEFAULT VALUES;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'Phase B RPC matrix: service_role directly inserted a partial quote';
  EXCEPTION
    WHEN insufficient_privilege THEN
      EXECUTE 'RESET ROLE';
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS stacked_message = MESSAGE_TEXT;
      EXECUTE 'RESET ROLE';
      RAISE EXCEPTION
        'Phase B RPC matrix: direct insert reached constraints instead of ACL (SQLSTATE %, message %)',
        SQLSTATE,
        stacked_message;
  END;

  FOREACH direct_insert IN ARRAY ARRAY[
    'INSERT INTO public.payment_attempts DEFAULT VALUES',
    'INSERT INTO public.payment_attempt_components DEFAULT VALUES',
    'INSERT INTO public.order_lines DEFAULT VALUES',
    'INSERT INTO public.order_line_options DEFAULT VALUES',
    'INSERT INTO public.provider_object_bindings DEFAULT VALUES'
  ]
  LOOP
    BEGIN
      EXECUTE 'SET LOCAL ROLE service_role';
      EXECUTE direct_insert;
      EXECUTE 'RESET ROLE';
      RAISE EXCEPTION 'Phase B RPC matrix: service_role directly inserted a partial graph: %', direct_insert;
    EXCEPTION
      WHEN insufficient_privilege THEN
        EXECUTE 'RESET ROLE';
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS stacked_message = MESSAGE_TEXT;
        EXECUTE 'RESET ROLE';
        RAISE EXCEPTION
          'Phase B RPC matrix: direct insert reached constraints instead of ACL (SQLSTATE %, message %)',
          SQLSTATE,
          stacked_message;
    END;
  END LOOP;

  -- Exercise the shared registry itself without needing provider credentials.
  PERFORM public.bind_phase_b_provider_object(
    'moyasar', 'payment', 'phase-b-cross-domain-test', 'payment_attempt', binding_source
  );
  BEGIN
    PERFORM public.bind_phase_b_provider_object(
      'moyasar', 'payment', 'phase-b-cross-domain-test', 'wallet_topup', gen_random_uuid()
    );
    RAISE EXCEPTION 'Phase B RPC matrix: provider id was reused across domains';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END
$phase_b_rpc_matrix$;

SELECT 'phase_b_quote_foundation RPC role matrix passed' AS result;
ROLLBACK;
