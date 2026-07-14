-- Approval-gated rollback for 20260715000000_phase_a_capability_containment.sql.
--
-- This restores the exact read-only Frankfurt baseline captured before Phase A:
--   * all 16 functions owned by postgres and executable by anon,
--     authenticated, and service_role;
--   * PUBLIC EXECUTE restored only on the nine functions that had it;
--   * the four original fixed search paths restored and the other 12 reset;
--   * postgres/public/function default ACL restored to
--     postgres + anon + authenticated + service_role, without PUBLIC;
--   * the original increment_loyalty_points body restored (reviewed md5 below);
--   * provider_unknown removed from the refund-status constraint only when no
--     row currently uses it.
--
-- SECURITY WARNING: this deliberately re-opens the capability exposure fixed by
-- Phase A. Run only after explicit approval and only against the proved target.

BEGIN;

DO $phase_a_rollback_preflight$
DECLARE
  expected record;
  function_oid oid;
  function_owner_oid oid;
  function_acl aclitem[];
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
      'Phase A rollback preflight: expected 16 reviewed overloads, found %',
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
      RAISE EXCEPTION 'Phase A rollback preflight: missing %', expected.signature;
    END IF;

    SELECT p.proowner, p.proacl
      INTO function_owner_oid, function_acl
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid = function_oid
       AND p.prosecdef
       AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[];

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Phase A rollback preflight: owner/definer/search-path drift for %',
        expected.signature;
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
        'Phase A rollback preflight: expected service-role-only ACL on %',
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
        'Phase A rollback preflight: exact contained ACL drift for %, raw ACL %',
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
      'Phase A rollback preflight: increment_loyalty_points is not the contained definition';
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
      'Phase A rollback preflight: contained default ACL drift, found %',
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
      'Phase A rollback preflight: unexpected privilege/grant option/grantor in public default ACL';
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
      'Phase A rollback preflight: contained global default ACL drift, found %',
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
      'Phase A rollback preflight: unexpected privilege/grant option/grantor in global default ACL';
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(c.oid, true), c.convalidated
    INTO refund_constraint_definition, refund_constraint_validated
    FROM pg_catalog.pg_constraint AS c
   WHERE c.conrelid = 'public.customer_orders'::pg_catalog.regclass
     AND c.conname = 'customer_orders_refund_status_valid'
     AND c.contype = 'c';

  SELECT pg_catalog.array_agg(rm[1] ORDER BY rm[1])
    INTO refund_statuses
    FROM pg_catalog.regexp_matches(
      refund_constraint_definition,
      $status_regex$'([^']+)'$status_regex$,
      'g'
    ) AS rm;

  IF NOT refund_constraint_validated
     OR refund_statuses IS DISTINCT FROM
       ARRAY['none', 'not_required', 'pending', 'provider_unknown', 'refund_failed', 'refunded', 'voided']::text[] THEN
    RAISE EXCEPTION
      'Phase A rollback preflight: contained refund constraint drift, found %',
      refund_statuses;
  END IF;

  -- Do not silently reinterpret an unknown provider outcome. An operator may,
  -- after independent provider reconciliation and explicit approval, map a row
  -- to pending before rerunning rollback, for example:
  --
  --   UPDATE public.customer_orders
  --      SET refund_status = 'pending'
  --    WHERE refund_status = 'provider_unknown';
  --
  -- The rollback itself stays fail-closed and performs no such data rewrite.
  IF EXISTS (
    SELECT 1
      FROM public.customer_orders
     WHERE refund_status = 'provider_unknown'
  ) THEN
    RAISE EXCEPTION
      'Phase A rollback blocked: provider_unknown rows require reconciliation and an approved explicit mapping';
  END IF;
END
$phase_a_rollback_preflight$;

-- Exact original Frankfurt/repository body. The postcondition verifies the
-- reviewed pg_get_functiondef MD5 after recreation.
CREATE OR REPLACE FUNCTION public.increment_loyalty_points(
  p_customer_id text,
  p_merchant_id text,
  p_points integer,
  p_config_version integer DEFAULT 1
)
RETURNS TABLE(points numeric, lifetime_points numeric)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  INSERT INTO loyalty_points (customer_id, merchant_id, points, lifetime_points, config_version)
  VALUES (p_customer_id, p_merchant_id, GREATEST(p_points, 0), GREATEST(p_points, 0), p_config_version)
  ON CONFLICT (customer_id, merchant_id) DO UPDATE SET
    points = loyalty_points.points + p_points,
    lifetime_points = CASE WHEN p_points > 0 THEN loyalty_points.lifetime_points + p_points ELSE loyalty_points.lifetime_points END,
    updated_at = now()
  RETURNING loyalty_points.points, loyalty_points.lifetime_points INTO points, lifetime_points;
  RETURN NEXT;
END;
$function$;

-- Restore the 12 originally unset configurations.
ALTER FUNCTION public.credit_customer_wallet(uuid, uuid, bigint, text, text, text, uuid, text)
  RESET search_path;
ALTER FUNCTION public.debit_customer_wallet(uuid, uuid, bigint, text, text)
  RESET search_path;
ALTER FUNCTION public.increment_loyalty_points(text, text, integer, integer)
  RESET search_path;
ALTER FUNCTION public.increment_promo_usage(uuid, text)
  RESET search_path;
ALTER FUNCTION public.redeem_promo(uuid, text, text, text, numeric, text)
  RESET search_path;
ALTER FUNCTION public.unredeem_promo(uuid, text)
  RESET search_path;
ALTER FUNCTION public.wallet_balance_mismatches()
  RESET search_path;
ALTER FUNCTION public.enroll_merchant_customer(uuid, text, text)
  RESET search_path;
ALTER FUNCTION public.expire_loyalty_cashback(text, text, numeric)
  RESET search_path;
ALTER FUNCTION public.expire_loyalty_points(text, text, numeric)
  RESET search_path;
ALTER FUNCTION public.redeem_loyalty_cashback(text, text, numeric, text, text, text, text, text, integer, uuid, text, text, jsonb)
  RESET search_path;
ALTER FUNCTION public.redeem_loyalty_points(text, text, numeric, text, text, text, text, text, uuid, uuid, text, text, jsonb)
  RESET search_path;

-- Restore the four original fixed configurations.
ALTER FUNCTION public.credit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  SET search_path TO public;
ALTER FUNCTION public.debit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  SET search_path TO public;
ALTER FUNCTION public.get_migration_status()
  SET search_path TO public, supabase_migrations;
ALTER FUNCTION public.get_user_email_confirmed(text)
  SET search_path TO public;

-- Start from a deterministic state for the four affected grantees.
REVOKE ALL ON FUNCTION public.credit_customer_wallet(uuid, uuid, bigint, text, text, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.debit_customer_wallet(uuid, uuid, bigint, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.credit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.debit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.increment_loyalty_points(text, text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.increment_promo_usage(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.redeem_promo(uuid, text, text, text, numeric, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.unredeem_promo(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.wallet_balance_mismatches()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enroll_merchant_customer(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.expire_loyalty_cashback(text, text, numeric)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.expire_loyalty_points(text, text, numeric)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_migration_status()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_user_email_confirmed(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.redeem_loyalty_cashback(text, text, numeric, text, text, text, text, text, integer, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.redeem_loyalty_points(text, text, numeric, text, text, text, text, text, uuid, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- All 16 had explicit/effective execution for the two API roles and the server
-- role in the captured baseline.
GRANT EXECUTE ON FUNCTION public.credit_customer_wallet(uuid, uuid, bigint, text, text, text, uuid, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.debit_customer_wallet(uuid, uuid, bigint, text, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.credit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.debit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.increment_loyalty_points(text, text, integer, integer)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.increment_promo_usage(uuid, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.redeem_promo(uuid, text, text, text, numeric, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unredeem_promo(uuid, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wallet_balance_mismatches()
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enroll_merchant_customer(uuid, text, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.expire_loyalty_cashback(text, text, numeric)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.expire_loyalty_points(text, text, numeric)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_migration_status()
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_email_confirmed(text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.redeem_loyalty_cashback(text, text, numeric, text, text, text, text, text, integer, uuid, text, text, jsonb)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.redeem_loyalty_points(text, text, numeric, text, text, text, text, text, uuid, uuid, text, text, jsonb)
  TO anon, authenticated, service_role;

-- PUBLIC EXECUTE existed on exactly these nine functions.
GRANT EXECUTE ON FUNCTION public.credit_customer_wallet(uuid, uuid, bigint, text, text, text, uuid, text)
  TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.debit_customer_wallet(uuid, uuid, bigint, text, text)
  TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.credit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.debit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_loyalty_points(text, text, integer, integer)
  TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_promo_usage(uuid, text)
  TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_promo(uuid, text, text, text, numeric, text)
  TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.unredeem_promo(uuid, text)
  TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.wallet_balance_mismatches()
  TO PUBLIC;

-- Restore the captured defaults. Granting PUBLIC globally returns PostgreSQL to
-- its built-in default and removes the Phase A global override row. PUBLIC was
-- not an entry in the schema-public row; that row regains only anon/auth.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO postgres, anon, authenticated, service_role;

ALTER TABLE public.customer_orders
  DROP CONSTRAINT customer_orders_refund_status_valid;
ALTER TABLE public.customer_orders
  ADD CONSTRAINT customer_orders_refund_status_valid
  CHECK (
    refund_status IS NULL
    OR refund_status IN (
      'refunded',
      'voided',
      'not_required',
      'refund_failed',
      'none',
      'pending'
    )
  ) NOT VALID;
ALTER TABLE public.customer_orders
  VALIDATE CONSTRAINT customer_orders_refund_status_valid;

DO $phase_a_rollback_postconditions$
DECLARE
  expected record;
  function_oid oid;
  function_owner_oid oid;
  function_acl aclitem[];
  function_config text[];
  public_can_execute boolean;
  acl_entry_count integer;
  default_grantees text[];
  global_default_row_count integer;
  refund_constraint_definition text;
  refund_constraint_validated boolean;
  refund_statuses text[];
BEGIN
  FOR expected IN
    SELECT *
      FROM (VALUES
        ('public.credit_customer_wallet(uuid,uuid,bigint,text,text,text,uuid,text)', NULL::text[], true),
        ('public.debit_customer_wallet(uuid,uuid,bigint,text,text)', NULL::text[], true),
        ('public.credit_sms_wallet_balance(uuid,integer,text,text,text,text,jsonb)', ARRAY['search_path=public']::text[], true),
        ('public.debit_sms_wallet_balance(uuid,integer,text,text,text,text,jsonb)', ARRAY['search_path=public']::text[], true),
        ('public.increment_loyalty_points(text,text,integer,integer)', NULL::text[], true),
        ('public.increment_promo_usage(uuid,text)', NULL::text[], true),
        ('public.redeem_promo(uuid,text,text,text,numeric,text)', NULL::text[], true),
        ('public.unredeem_promo(uuid,text)', NULL::text[], true),
        ('public.wallet_balance_mismatches()', NULL::text[], true),
        ('public.enroll_merchant_customer(uuid,text,text)', NULL::text[], false),
        ('public.expire_loyalty_cashback(text,text,numeric)', NULL::text[], false),
        ('public.expire_loyalty_points(text,text,numeric)', NULL::text[], false),
        ('public.get_migration_status()', ARRAY['search_path=public, supabase_migrations']::text[], false),
        ('public.get_user_email_confirmed(text)', ARRAY['search_path=public']::text[], false),
        ('public.redeem_loyalty_cashback(text,text,numeric,text,text,text,text,text,integer,uuid,text,text,jsonb)', NULL::text[], false),
        ('public.redeem_loyalty_points(text,text,numeric,text,text,text,text,text,uuid,uuid,text,text,jsonb)', NULL::text[], false)
      ) AS inventory(signature, original_config, original_public_execute)
  LOOP
    function_oid := pg_catalog.to_regprocedure(expected.signature);
    IF function_oid IS NULL THEN
      RAISE EXCEPTION 'Phase A rollback postcondition: missing %', expected.signature;
    END IF;

    SELECT p.proowner, p.proacl, p.proconfig
      INTO function_owner_oid, function_acl, function_config
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid = function_oid
       AND p.prosecdef
       AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres';

    IF NOT FOUND OR function_config IS DISTINCT FROM expected.original_config THEN
      RAISE EXCEPTION
        'Phase A rollback postcondition: owner/definer/config mismatch for %',
        expected.signature;
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

    IF public_can_execute IS DISTINCT FROM expected.original_public_execute
       OR NOT pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'Phase A rollback postcondition: ACL mismatch for %',
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

    IF acl_entry_count <> (CASE WHEN expected.original_public_execute THEN 5 ELSE 4 END)
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
             OR (acl.grantee = 0 AND NOT expected.original_public_execute)
             OR (
               acl.grantee <> 0
               AND NOT (
                 pg_catalog.pg_get_userbyid(acl.grantee) = ANY (
                   ARRAY['postgres', 'anon', 'authenticated', 'service_role']
                 )
               )
             )
       ) THEN
      RAISE EXCEPTION
        'Phase A rollback postcondition: exact ACL mismatch for %, raw ACL %',
        expected.signature,
        function_acl;
    END IF;
  END LOOP;

  IF pg_catalog.md5(
       pg_catalog.pg_get_functiondef(
         pg_catalog.to_regprocedure('public.increment_loyalty_points(text,text,integer,integer)')
       )
     ) <> '6d573c098528fe9b4d0126c0a3bf3533' THEN
    RAISE EXCEPTION
      'Phase A rollback postcondition: original increment_loyalty_points body was not restored';
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

  IF default_grantees IS DISTINCT FROM ARRAY['anon', 'authenticated', 'postgres', 'service_role']::text[] THEN
    RAISE EXCEPTION
      'Phase A rollback postcondition: original default ACL was not restored, found %',
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
      'Phase A rollback postcondition: unexpected privilege/grant option/grantor in public default ACL';
  END IF;

  SELECT count(*)
    INTO global_default_row_count
    FROM pg_catalog.pg_default_acl AS d
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = d.defaclrole
   WHERE owner_role.rolname = 'postgres'
     AND d.defaclnamespace = 0
     AND d.defaclobjtype = 'f';

  IF global_default_row_count <> 0 THEN
    RAISE EXCEPTION
      'Phase A rollback postcondition: expected global default override row removal, found % row(s)',
      global_default_row_count;
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(c.oid, true), c.convalidated
    INTO refund_constraint_definition, refund_constraint_validated
    FROM pg_catalog.pg_constraint AS c
   WHERE c.conrelid = 'public.customer_orders'::pg_catalog.regclass
     AND c.conname = 'customer_orders_refund_status_valid'
     AND c.contype = 'c';

  SELECT pg_catalog.array_agg(rm[1] ORDER BY rm[1])
    INTO refund_statuses
    FROM pg_catalog.regexp_matches(
      refund_constraint_definition,
      $status_regex$'([^']+)'$status_regex$,
      'g'
    ) AS rm;

  IF NOT refund_constraint_validated
     OR refund_statuses IS DISTINCT FROM
       ARRAY['none', 'not_required', 'pending', 'refund_failed', 'refunded', 'voided']::text[] THEN
    RAISE EXCEPTION
      'Phase A rollback postcondition: original refund constraint was not restored, found %',
      refund_statuses;
  END IF;
END
$phase_a_rollback_postconditions$;

COMMIT;
