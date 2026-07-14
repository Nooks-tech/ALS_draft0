-- Isolated-database execution matrix for Phase A.
--
-- This intentionally invokes every reviewed function. Calls use null/zero
-- fixtures and the entire script rolls back, but it must never be run against
-- Frankfurt or Tokyo. Use run-phase-a-cycle.ps1, which rejects non-loopback
-- database hosts before executing this file.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

DO $phase_a_rpc_matrix$
DECLARE
  role_name text;
  invocation record;
  stacked_message text;
  positive_points numeric;
  positive_lifetime_points numeric;
BEGIN
  IF CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres' THEN
    RAISE EXCEPTION
      'Phase A RPC matrix must run as local fixture owner postgres';
  END IF;

  -- A function created after Phase A must inherit the combined global +
  -- public-schema default ACL: postgres/service_role only.
  EXECUTE $probe$
    CREATE FUNCTION public.phase_a_default_acl_probe()
    RETURNS integer
    LANGUAGE sql
    AS 'SELECT 1'
  $probe$;

  IF EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS p
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
         ) AS acl
        WHERE p.oid = 'public.phase_a_default_acl_probe()'::pg_catalog.regprocedure
          AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', 'public.phase_a_default_acl_probe()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.phase_a_default_acl_probe()', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', 'public.phase_a_default_acl_probe()', 'EXECUTE') THEN
    RAISE EXCEPTION
      'Phase A RPC matrix: future-function default ACL is not service-role-only';
  END IF;

  -- Concrete positive workflow for the only replaced function body. This is
  -- stronger than the generic service-role loop below: it proves the call
  -- actually mutates the qualified table and returns the expected 5|5 balance.
  -- The outer transaction rolls this fixture row back.
  DELETE FROM public.loyalty_points
   WHERE customer_id = '__phase_a_service_positive_customer__'
     AND merchant_id = '__phase_a_service_positive_merchant__';

  BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
    EXECUTE $positive_call$
      SELECT points, lifetime_points
        FROM public.increment_loyalty_points(
          '__phase_a_service_positive_customer__',
          '__phase_a_service_positive_merchant__',
          5,
          1
        )
    $positive_call$
      INTO positive_points, positive_lifetime_points;
    EXECUTE 'RESET ROLE';
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS stacked_message = MESSAGE_TEXT;
      EXECUTE 'RESET ROLE';
      RAISE EXCEPTION
        'Phase A RPC matrix: concrete service-role increment failed (SQLSTATE %, message %)',
        SQLSTATE,
        stacked_message;
  END;

  IF positive_points IS DISTINCT FROM 5::numeric
     OR positive_lifetime_points IS DISTINCT FROM 5::numeric
     OR NOT EXISTS (
       SELECT 1
         FROM public.loyalty_points
        WHERE customer_id = '__phase_a_service_positive_customer__'
          AND merchant_id = '__phase_a_service_positive_merchant__'
          AND points = 5::numeric
          AND lifetime_points = 5::numeric
     ) THEN
    RAISE EXCEPTION
      'Phase A RPC matrix: concrete increment expected 5|5, returned %|%',
      positive_points,
      positive_lifetime_points;
  END IF;

  -- Exercise real permission checks as each untrusted API role. If a call
  -- reaches validation or a table, containment failed even if that body later
  -- raises for the deliberately invalid fixture.
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']::text[]
  LOOP
    FOR invocation IN
      SELECT *
        FROM (VALUES
          ('credit_customer_wallet', $call$SELECT * FROM public.credit_customer_wallet(NULL::uuid, NULL::uuid, 0::bigint, 'adjustment'::text, NULL::text, NULL::text, NULL::uuid, NULL::text)$call$),
          ('debit_customer_wallet', $call$SELECT * FROM public.debit_customer_wallet(NULL::uuid, NULL::uuid, 0::bigint, NULL::text, NULL::text)$call$),
          ('credit_sms_wallet_balance', $call$SELECT * FROM public.credit_sms_wallet_balance(NULL::uuid, 0::integer, NULL::text, 'manual_adjustment'::text, NULL::text, NULL::text, '{}'::jsonb)$call$),
          ('debit_sms_wallet_balance', $call$SELECT * FROM public.debit_sms_wallet_balance(NULL::uuid, 0::integer, NULL::text, NULL::text, NULL::text, NULL::text, '{}'::jsonb)$call$),
          ('increment_loyalty_points', $call$SELECT * FROM public.increment_loyalty_points(NULL::text, NULL::text, 0::integer, 1::integer)$call$),
          ('increment_promo_usage', $call$SELECT public.increment_promo_usage(NULL::uuid, NULL::text)$call$),
          ('redeem_promo', $call$SELECT * FROM public.redeem_promo(NULL::uuid, NULL::text, NULL::text, NULL::text, 0::numeric, NULL::text)$call$),
          ('unredeem_promo', $call$SELECT public.unredeem_promo(NULL::uuid, NULL::text)$call$),
          ('wallet_balance_mismatches', $call$SELECT * FROM public.wallet_balance_mismatches()$call$),
          ('enroll_merchant_customer', $call$SELECT public.enroll_merchant_customer(NULL::uuid, NULL::text, NULL::text)$call$),
          ('expire_loyalty_cashback', $call$SELECT public.expire_loyalty_cashback(NULL::text, NULL::text, 0::numeric)$call$),
          ('expire_loyalty_points', $call$SELECT public.expire_loyalty_points(NULL::text, NULL::text, 0::numeric)$call$),
          ('get_migration_status', $call$SELECT * FROM public.get_migration_status()$call$),
          ('get_user_email_confirmed', $call$SELECT public.get_user_email_confirmed('__phase_a_missing__@invalid.example'::text)$call$),
          ('redeem_loyalty_cashback', $call$SELECT public.redeem_loyalty_cashback(NULL::text, NULL::text, 0::numeric, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::uuid, NULL::text, NULL::text, '{}'::jsonb)$call$),
          ('redeem_loyalty_points', $call$SELECT public.redeem_loyalty_points(NULL::text, NULL::text, 0::numeric, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text, '{}'::jsonb)$call$)
        ) AS calls(function_name, sql_text)
    LOOP
      BEGIN
        EXECUTE pg_catalog.format('SET LOCAL ROLE %I', role_name);
        EXECUTE invocation.sql_text;
        EXECUTE 'RESET ROLE';

        RAISE EXCEPTION
          'Phase A RPC matrix: role % unexpectedly executed %',
          role_name,
          invocation.function_name;
      EXCEPTION
        WHEN insufficient_privilege THEN
          EXECUTE 'RESET ROLE';
        WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS stacked_message = MESSAGE_TEXT;
          EXECUTE 'RESET ROLE';
          RAISE EXCEPTION
            'Phase A RPC matrix: role % reached % body (SQLSTATE %, message %)',
            role_name,
            invocation.function_name,
            SQLSTATE,
            stacked_message;
      END;
    END LOOP;
  END LOOP;

  -- The same calls must pass the EXECUTE boundary for service_role. This loop
  -- is boundary-reach coverage only: body-level validation errors are accepted
  -- for deliberately invalid fixtures. The concrete increment above is the
  -- positive mutation/return-value workflow proof.
  FOR invocation IN
    SELECT *
      FROM (VALUES
        ('credit_customer_wallet', $call$SELECT * FROM public.credit_customer_wallet(NULL::uuid, NULL::uuid, 0::bigint, 'adjustment'::text, NULL::text, NULL::text, NULL::uuid, NULL::text)$call$),
        ('debit_customer_wallet', $call$SELECT * FROM public.debit_customer_wallet(NULL::uuid, NULL::uuid, 0::bigint, NULL::text, NULL::text)$call$),
        ('credit_sms_wallet_balance', $call$SELECT * FROM public.credit_sms_wallet_balance(NULL::uuid, 0::integer, NULL::text, 'manual_adjustment'::text, NULL::text, NULL::text, '{}'::jsonb)$call$),
        ('debit_sms_wallet_balance', $call$SELECT * FROM public.debit_sms_wallet_balance(NULL::uuid, 0::integer, NULL::text, NULL::text, NULL::text, NULL::text, '{}'::jsonb)$call$),
        ('increment_loyalty_points', $call$SELECT * FROM public.increment_loyalty_points(NULL::text, NULL::text, 0::integer, 1::integer)$call$),
        ('increment_promo_usage', $call$SELECT public.increment_promo_usage(NULL::uuid, NULL::text)$call$),
        ('redeem_promo', $call$SELECT * FROM public.redeem_promo(NULL::uuid, NULL::text, NULL::text, NULL::text, 0::numeric, NULL::text)$call$),
        ('unredeem_promo', $call$SELECT public.unredeem_promo(NULL::uuid, NULL::text)$call$),
        ('wallet_balance_mismatches', $call$SELECT * FROM public.wallet_balance_mismatches()$call$),
        ('enroll_merchant_customer', $call$SELECT public.enroll_merchant_customer(NULL::uuid, NULL::text, NULL::text)$call$),
        ('expire_loyalty_cashback', $call$SELECT public.expire_loyalty_cashback(NULL::text, NULL::text, 0::numeric)$call$),
        ('expire_loyalty_points', $call$SELECT public.expire_loyalty_points(NULL::text, NULL::text, 0::numeric)$call$),
        ('get_migration_status', $call$SELECT * FROM public.get_migration_status()$call$),
        ('get_user_email_confirmed', $call$SELECT public.get_user_email_confirmed('__phase_a_missing__@invalid.example'::text)$call$),
        ('redeem_loyalty_cashback', $call$SELECT public.redeem_loyalty_cashback(NULL::text, NULL::text, 0::numeric, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::uuid, NULL::text, NULL::text, '{}'::jsonb)$call$),
        ('redeem_loyalty_points', $call$SELECT public.redeem_loyalty_points(NULL::text, NULL::text, 0::numeric, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text, '{}'::jsonb)$call$)
      ) AS calls(function_name, sql_text)
  LOOP
    BEGIN
      EXECUTE 'SET LOCAL ROLE service_role';
      EXECUTE invocation.sql_text;
      EXECUTE 'RESET ROLE';
    EXCEPTION
      WHEN insufficient_privilege THEN
        GET STACKED DIAGNOSTICS stacked_message = MESSAGE_TEXT;
        EXECUTE 'RESET ROLE';
        RAISE EXCEPTION
          'Phase A RPC matrix: service_role privilege failure for %: %',
          invocation.function_name,
          stacked_message;
      WHEN OTHERS THEN
        -- Expected for positive/amount checks and null fixture constraints: the
        -- function body was reached, proving the service contract remains.
        EXECUTE 'RESET ROLE';
    END;
  END LOOP;
END
$phase_a_rpc_matrix$;

SELECT 'phase_a_capability_containment RPC role matrix passed' AS result;

-- Removes the probe and undoes every fixture-side effect.
ROLLBACK;
