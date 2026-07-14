-- Read-only catalog/ACL verification for
-- 20260715000000_phase_a_capability_containment.sql.
--
-- Run only against an isolated migrated database or an explicitly approved
-- target, for example:
--   psql -X -v ON_ERROR_STOP=1 "$PHASE_A_DATABASE_URL" \
--     -f supabase/tests/phase_a_capability_containment.sql

\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

DO $phase_a_catalog_test$
DECLARE
  expected record;
  function_oid oid;
  function_owner_oid oid;
  function_acl aclitem[];
  function_config text[];
  public_can_execute boolean;
  acl_entry_count integer;
  actual_count integer;
  default_grantees text[];
  global_default_grantees text[];
  refund_constraint_definition text;
  refund_constraint_validated boolean;
  refund_statuses text[];
BEGIN
  SELECT count(*)
    INTO actual_count
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = ANY (ARRAY[
       'credit_customer_wallet',
       'debit_customer_wallet',
       'credit_sms_wallet_balance',
       'debit_sms_wallet_balance',
       'increment_loyalty_points',
       'increment_promo_usage',
       'redeem_promo',
       'unredeem_promo',
       'wallet_balance_mismatches',
       'enroll_merchant_customer',
       'expire_loyalty_cashback',
       'expire_loyalty_points',
       'get_migration_status',
       'get_user_email_confirmed',
       'redeem_loyalty_cashback',
       'redeem_loyalty_points'
     ]);

  IF actual_count <> 16 THEN
    RAISE EXCEPTION
      'Phase A test: expected exactly 16 reviewed overloads, found %',
      actual_count;
  END IF;

  FOR expected IN
    SELECT signature
      FROM (VALUES
        ('public.credit_customer_wallet(uuid,uuid,bigint,text,text,text,uuid,text)'),
        ('public.debit_customer_wallet(uuid,uuid,bigint,text,text)'),
        ('public.credit_sms_wallet_balance(uuid,integer,text,text,text,text,jsonb)'),
        ('public.debit_sms_wallet_balance(uuid,integer,text,text,text,text,jsonb)'),
        ('public.increment_loyalty_points(text,text,integer,integer)'),
        ('public.increment_promo_usage(uuid,text)'),
        ('public.redeem_promo(uuid,text,text,text,numeric,text)'),
        ('public.unredeem_promo(uuid,text)'),
        ('public.wallet_balance_mismatches()'),
        ('public.enroll_merchant_customer(uuid,text,text)'),
        ('public.expire_loyalty_cashback(text,text,numeric)'),
        ('public.expire_loyalty_points(text,text,numeric)'),
        ('public.get_migration_status()'),
        ('public.get_user_email_confirmed(text)'),
        ('public.redeem_loyalty_cashback(text,text,numeric,text,text,text,text,text,integer,uuid,text,text,jsonb)'),
        ('public.redeem_loyalty_points(text,text,numeric,text,text,text,text,text,uuid,uuid,text,text,jsonb)')
      ) AS inventory(signature)
  LOOP
    function_oid := pg_catalog.to_regprocedure(expected.signature);
    IF function_oid IS NULL THEN
      RAISE EXCEPTION 'Phase A test: missing %', expected.signature;
    END IF;

    SELECT p.proowner, p.proacl, p.proconfig
      INTO function_owner_oid, function_acl, function_config
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid = function_oid
       AND p.prosecdef
       AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres';

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Phase A test: % is not postgres-owned SECURITY DEFINER',
        expected.signature;
    END IF;

    IF function_config IS DISTINCT FROM ARRAY['search_path=""']::text[] THEN
      RAISE EXCEPTION
        'Phase A test: unsafe config for %, found %',
        expected.signature,
        function_config;
    END IF;

    SELECT EXISTS (
      SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            function_acl,
            pg_catalog.acldefault('f', function_owner_oid)
          )
        ) AS acl
       WHERE acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
    ) INTO public_can_execute;

    IF public_can_execute
       OR pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'Phase A test: % is not service-role-only',
        expected.signature;
    END IF;

    SELECT count(*)
      INTO acl_entry_count
      FROM pg_catalog.aclexplode(
        COALESCE(
          function_acl,
          pg_catalog.acldefault('f', function_owner_oid)
        )
      ) AS acl;

    IF acl_entry_count <> 2
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.aclexplode(
             COALESCE(
               function_acl,
               pg_catalog.acldefault('f', function_owner_oid)
             )
           ) AS acl
          WHERE acl.privilege_type <> 'EXECUTE'
             OR acl.is_grantable
             OR pg_catalog.pg_get_userbyid(acl.grantor) <> 'postgres'
             OR acl.grantee = 0
             OR NOT (
               pg_catalog.pg_get_userbyid(acl.grantee) = ANY (
                 ARRAY['postgres', 'service_role']
               )
             )
       ) THEN
      RAISE EXCEPTION
        'Phase A test: unexpected grantee/grantor/grant option for %, raw ACL %',
        expected.signature,
        function_acl;
    END IF;
  END LOOP;

  IF pg_catalog.md5(
       pg_catalog.pg_get_functiondef(
         pg_catalog.to_regprocedure('public.increment_loyalty_points(text,text,integer,integer)')
       )
     ) = '6d573c098528fe9b4d0126c0a3bf3533'
     OR pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         pg_catalog.to_regprocedure('public.increment_loyalty_points(text,text,integer,integer)')
       ),
       'INSERT INTO public.loyalty_points'
     ) = 0 THEN
    RAISE EXCEPTION
      'Phase A test: increment_loyalty_points is not the qualified replacement';
  END IF;

  SELECT count(*)
    INTO actual_count
    FROM pg_catalog.pg_trigger AS t
    JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = ANY (ARRAY[
       'credit_customer_wallet',
       'debit_customer_wallet',
       'credit_sms_wallet_balance',
       'debit_sms_wallet_balance',
       'increment_loyalty_points',
       'increment_promo_usage',
       'redeem_promo',
       'unredeem_promo',
       'wallet_balance_mismatches',
       'enroll_merchant_customer',
       'expire_loyalty_cashback',
       'expire_loyalty_points',
       'get_migration_status',
       'get_user_email_confirmed',
       'redeem_loyalty_cashback',
       'redeem_loyalty_points'
     ]);

  IF actual_count <> 0 THEN
    RAISE EXCEPTION
      'Phase A test: reviewed functions have % unexpected trigger binding(s)',
      actual_count;
  END IF;

  SELECT pg_catalog.array_agg(
           CASE
             WHEN acl.grantee = 0 THEN 'PUBLIC'
             ELSE pg_catalog.pg_get_userbyid(acl.grantee)
           END
           ORDER BY
             CASE
               WHEN acl.grantee = 0 THEN 'PUBLIC'
               ELSE pg_catalog.pg_get_userbyid(acl.grantee)
             END
         )
    INTO default_grantees
    FROM pg_catalog.pg_default_acl AS d
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = d.defaclrole
    JOIN pg_catalog.pg_namespace AS n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) AS acl
   WHERE owner_role.rolname = 'postgres'
     AND n.nspname = 'public'
     AND d.defaclobjtype = 'f'
     AND acl.privilege_type = 'EXECUTE';

  IF default_grantees IS DISTINCT FROM ARRAY['postgres', 'service_role']::text[] THEN
    RAISE EXCEPTION
      'Phase A test: default function ACL is not fail-closed, found %',
      default_grantees;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_default_acl AS d
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = d.defaclrole
      JOIN pg_catalog.pg_namespace AS n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) AS acl
     WHERE owner_role.rolname = 'postgres'
       AND n.nspname = 'public'
       AND d.defaclobjtype = 'f'
       AND (
         acl.privilege_type <> 'EXECUTE'
         OR acl.is_grantable
         OR pg_catalog.pg_get_userbyid(acl.grantor) <> 'postgres'
       )
  ) THEN
    RAISE EXCEPTION
      'Phase A test: unexpected privilege/grant option/grantor in default ACL';
  END IF;

  SELECT pg_catalog.array_agg(
           CASE
             WHEN acl.grantee = 0 THEN 'PUBLIC'
             ELSE pg_catalog.pg_get_userbyid(acl.grantee)
           END
           ORDER BY
             CASE
               WHEN acl.grantee = 0 THEN 'PUBLIC'
               ELSE pg_catalog.pg_get_userbyid(acl.grantee)
             END
         )
    INTO global_default_grantees
    FROM pg_catalog.pg_default_acl AS d
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = d.defaclrole
    CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) AS acl
   WHERE owner_role.rolname = 'postgres'
     AND d.defaclnamespace = 0
     AND d.defaclobjtype = 'f'
     AND acl.privilege_type = 'EXECUTE';

  IF global_default_grantees IS DISTINCT FROM ARRAY['postgres']::text[] THEN
    RAISE EXCEPTION
      'Phase A test: global default function ACL is not fail-closed, found %',
      global_default_grantees;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_default_acl AS d
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = d.defaclrole
      CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) AS acl
     WHERE owner_role.rolname = 'postgres'
       AND d.defaclnamespace = 0
       AND d.defaclobjtype = 'f'
       AND (
         acl.privilege_type <> 'EXECUTE'
         OR acl.is_grantable
         OR pg_catalog.pg_get_userbyid(acl.grantor) <> 'postgres'
       )
  ) THEN
    RAISE EXCEPTION
      'Phase A test: unexpected privilege/grant option/grantor in global default ACL';
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(c.oid, true), c.convalidated
    INTO refund_constraint_definition, refund_constraint_validated
    FROM pg_catalog.pg_constraint AS c
   WHERE c.conrelid = 'public.customer_orders'::pg_catalog.regclass
     AND c.conname = 'customer_orders_refund_status_valid'
     AND c.contype = 'c';

  IF refund_constraint_definition IS NULL OR NOT refund_constraint_validated THEN
    RAISE EXCEPTION
      'Phase A test: validated refund-status constraint is missing';
  END IF;

  SELECT pg_catalog.array_agg(rm[1] ORDER BY rm[1])
    INTO refund_statuses
    FROM pg_catalog.regexp_matches(
      refund_constraint_definition,
      $status_regex$'([^']+)'$status_regex$,
      'g'
    ) AS rm;

  IF refund_statuses IS DISTINCT FROM
       ARRAY['none', 'not_required', 'pending', 'provider_unknown', 'refund_failed', 'refunded', 'voided']::text[] THEN
    RAISE EXCEPTION
      'Phase A test: refund status literals are wrong, found %',
      refund_statuses;
  END IF;
END
$phase_a_catalog_test$;

SELECT 'phase_a_capability_containment catalog/ACL assertions passed' AS result;

ROLLBACK;
