-- Phase A: contain the 16 privileged RPCs proven executable by untrusted roles.
--
-- IMPORTANT:
--   * This migration is authored in ALS_draft0 only. Do not mirror it into
--     nooksweb; both repositories target the same database.
--   * Production is Frankfurt project rmslvptafkxywhpzpuxt. The repository's
--     local Supabase link points at the Tokyo rollback project and must not be
--     used to apply or verify this migration.
--   * The preflight below is pinned to the read-only Frankfurt inventory taken
--     before this file was authored. Any owner, signature, ACL, search-path,
--     overload, trigger, default-ACL, or function-body drift aborts the whole
--     transaction for review.
--   * Live application and rollback are separate approval-gated operations.

BEGIN;

DO $phase_a_preflight$
DECLARE
  expected record;
  function_oid oid;
  function_owner_oid oid;
  function_owner text;
  function_is_definer boolean;
  function_config text[];
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
  -- Exact inventory: one overload for each of these 16 names.
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
      'Phase A preflight: expected exactly 16 reviewed function overloads, found %',
      actual_count;
  END IF;

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
      RAISE EXCEPTION 'Phase A preflight: missing function %', expected.signature;
    END IF;

    SELECT p.proowner,
           pg_catalog.pg_get_userbyid(p.proowner),
           p.prosecdef,
           p.proconfig,
           p.proacl
      INTO function_owner_oid,
           function_owner,
           function_is_definer,
           function_config,
           function_acl
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid = function_oid;

    IF function_owner <> 'postgres' THEN
      RAISE EXCEPTION
        'Phase A preflight: owner drift for %, expected postgres, found %',
        expected.signature,
        function_owner;
    END IF;

    IF NOT function_is_definer THEN
      RAISE EXCEPTION 'Phase A preflight: % is no longer SECURITY DEFINER', expected.signature;
    END IF;

    IF function_config IS DISTINCT FROM expected.original_config THEN
      RAISE EXCEPTION
        'Phase A preflight: search-path/config drift for %, expected %, found %',
        expected.signature,
        expected.original_config,
        function_config;
    END IF;

    IF NOT pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'Phase A preflight: expected anon/authenticated/service_role EXECUTE on %',
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

    IF public_can_execute IS DISTINCT FROM expected.original_public_execute THEN
      RAISE EXCEPTION
        'Phase A preflight: PUBLIC ACL drift for %, expected %, found %',
        expected.signature,
        expected.original_public_execute,
        public_can_execute;
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
        'Phase A preflight: exact function ACL drift for %, raw ACL %',
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
      'Phase A preflight: increment_loyalty_points definition drifted from the reviewed Frankfurt body';
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
      'Phase A preflight: reviewed functions gained % trigger binding(s); manual trigger testing is required',
      actual_count;
  END IF;

  SELECT count(*)
    INTO actual_count
    FROM pg_catalog.pg_default_acl AS d
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = d.defaclrole
    JOIN pg_catalog.pg_namespace AS n ON n.oid = d.defaclnamespace
   WHERE owner_role.rolname = 'postgres'
     AND n.nspname = 'public'
     AND d.defaclobjtype = 'f';

  IF actual_count <> 1 THEN
    RAISE EXCEPTION
      'Phase A preflight: expected one postgres/public/function default ACL row, found %',
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

  IF default_grantees IS DISTINCT FROM ARRAY['anon', 'authenticated', 'postgres', 'service_role']::text[] THEN
    RAISE EXCEPTION
      'Phase A preflight: postgres/public/function default ACL drift, found %',
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
      'Phase A preflight: unexpected privilege, grant option, or grantor in function default ACL';
  END IF;

  -- Frankfurt had no global postgres/function pg_default_acl row. That means
  -- PostgreSQL's built-in global default still granted EXECUTE to PUBLIC.
  SELECT count(*)
    INTO actual_count
    FROM pg_catalog.pg_default_acl AS d
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = d.defaclrole
   WHERE owner_role.rolname = 'postgres'
     AND d.defaclnamespace = 0
     AND d.defaclobjtype = 'f';

  IF actual_count <> 0 THEN
    RAISE EXCEPTION
      'Phase A preflight: expected no global postgres/function default ACL row, found %',
      actual_count;
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(c.oid, true), c.convalidated
    INTO refund_constraint_definition, refund_constraint_validated
    FROM pg_catalog.pg_constraint AS c
   WHERE c.conrelid = 'public.customer_orders'::pg_catalog.regclass
     AND c.conname = 'customer_orders_refund_status_valid'
     AND c.contype = 'c';

  IF refund_constraint_definition IS NULL OR NOT refund_constraint_validated THEN
    RAISE EXCEPTION
      'Phase A preflight: validated customer_orders_refund_status_valid constraint is missing';
  END IF;

  SELECT pg_catalog.array_agg(rm[1] ORDER BY rm[1])
    INTO refund_statuses
    FROM pg_catalog.regexp_matches(
      refund_constraint_definition,
      $status_regex$'([^']+)'$status_regex$,
      'g'
    ) AS rm;

  IF refund_statuses IS DISTINCT FROM
       ARRAY['none', 'not_required', 'pending', 'refund_failed', 'refunded', 'voided']::text[] THEN
    RAISE EXCEPTION
      'Phase A preflight: refund status constraint drift, found literals %',
      refund_statuses;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.customer_orders
     WHERE refund_status = 'provider_unknown'
  ) THEN
    RAISE EXCEPTION
      'Phase A preflight: provider_unknown rows exist before the constraint is widened';
  END IF;
END
$phase_a_preflight$;

-- Only this function needs a body edit. Its original body resolves
-- loyalty_points through the caller-controlled search path. Preserve all money
-- semantics and argument/return contracts; qualify only the target relation and
-- pin an empty function search path.
CREATE OR REPLACE FUNCTION public.increment_loyalty_points(
  p_customer_id text,
  p_merchant_id text,
  p_points integer,
  p_config_version integer DEFAULT 1
)
RETURNS TABLE(points numeric, lifetime_points numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.loyalty_points AS current_balance (customer_id, merchant_id, points, lifetime_points, config_version)
  VALUES (p_customer_id, p_merchant_id, GREATEST(p_points, 0), GREATEST(p_points, 0), p_config_version)
  ON CONFLICT (customer_id, merchant_id) DO UPDATE SET
    points = current_balance.points + p_points,
    lifetime_points = CASE WHEN p_points > 0 THEN current_balance.lifetime_points + p_points ELSE current_balance.lifetime_points END,
    updated_at = pg_catalog.now()
  RETURNING current_balance.points, current_balance.lifetime_points INTO points, lifetime_points;
  RETURN NEXT;
END;
$function$;

-- The other 15 reviewed bodies already schema-qualify every relation. ALTER
-- their configuration without replacing application logic or changing OIDs.
ALTER FUNCTION public.credit_customer_wallet(uuid, uuid, bigint, text, text, text, uuid, text)
  SET search_path TO '';
ALTER FUNCTION public.debit_customer_wallet(uuid, uuid, bigint, text, text)
  SET search_path TO '';
ALTER FUNCTION public.credit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  SET search_path TO '';
ALTER FUNCTION public.debit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  SET search_path TO '';
ALTER FUNCTION public.increment_promo_usage(uuid, text)
  SET search_path TO '';
ALTER FUNCTION public.redeem_promo(uuid, text, text, text, numeric, text)
  SET search_path TO '';
ALTER FUNCTION public.unredeem_promo(uuid, text)
  SET search_path TO '';
ALTER FUNCTION public.wallet_balance_mismatches()
  SET search_path TO '';
ALTER FUNCTION public.enroll_merchant_customer(uuid, text, text)
  SET search_path TO '';
ALTER FUNCTION public.expire_loyalty_cashback(text, text, numeric)
  SET search_path TO '';
ALTER FUNCTION public.expire_loyalty_points(text, text, numeric)
  SET search_path TO '';
ALTER FUNCTION public.get_migration_status()
  SET search_path TO '';
ALTER FUNCTION public.get_user_email_confirmed(text)
  SET search_path TO '';
ALTER FUNCTION public.redeem_loyalty_cashback(text, text, numeric, text, text, text, text, text, integer, uuid, text, text, jsonb)
  SET search_path TO '';
ALTER FUNCTION public.redeem_loyalty_points(text, text, numeric, text, text, text, text, text, uuid, uuid, text, text, jsonb)
  SET search_path TO '';

-- Remove both inherited PUBLIC execution and the explicit Supabase API-role
-- grants. Then restore only the existing server contract.
REVOKE ALL ON FUNCTION public.credit_customer_wallet(uuid, uuid, bigint, text, text, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.debit_customer_wallet(uuid, uuid, bigint, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.credit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.debit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_loyalty_points(text, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_promo_usage(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_promo(uuid, text, text, text, numeric, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unredeem_promo(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wallet_balance_mismatches()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enroll_merchant_customer(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_loyalty_cashback(text, text, numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_loyalty_points(text, text, numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_migration_status()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_user_email_confirmed(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_loyalty_cashback(text, text, numeric, text, text, text, text, text, integer, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_loyalty_points(text, text, numeric, text, text, text, text, text, uuid, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.credit_customer_wallet(uuid, uuid, bigint, text, text, text, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.debit_customer_wallet(uuid, uuid, bigint, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.credit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.debit_sms_wallet_balance(uuid, integer, text, text, text, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_loyalty_points(text, text, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_promo_usage(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_promo(uuid, text, text, text, numeric, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.unredeem_promo(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.wallet_balance_mismatches()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.enroll_merchant_customer(uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_loyalty_cashback(text, text, numeric)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_loyalty_points(text, text, numeric)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_migration_status()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_user_email_confirmed(text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_loyalty_cashback(text, text, numeric, text, text, text, text, text, integer, uuid, text, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_loyalty_points(text, text, numeric, text, text, text, text, text, uuid, uuid, text, text, jsonb)
  TO service_role;

-- The read-only Frankfurt snapshot proved postgres owns all reviewed functions
-- and owns the only public-schema function default ACL. Abort above if that
-- changes; never silently guard the wrong creator role.
-- Schema-specific default ACLs are additive; revoking PUBLIC only inside
-- schema public does not override PostgreSQL's global built-in PUBLIC grant.
-- Install a global PUBLIC deny for postgres-created functions, then remove the
-- explicit API-role grants from the existing public-schema row. Do not touch
-- the separate storage-schema default ACL.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

-- Unknown provider state is durable/retryable, not a failed refund and not a
-- reason to compensate through a different rail.
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
      'pending',
      'provider_unknown'
    )
  ) NOT VALID;
ALTER TABLE public.customer_orders
  VALIDATE CONSTRAINT customer_orders_refund_status_valid;

DO $phase_a_postconditions$
DECLARE
  expected record;
  function_oid oid;
  function_owner_oid oid;
  function_owner text;
  function_is_definer boolean;
  function_config text[];
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
      'Phase A postcondition: expected 16 reviewed overloads, found %',
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
      RAISE EXCEPTION 'Phase A postcondition: missing function %', expected.signature;
    END IF;

    SELECT p.proowner,
           pg_catalog.pg_get_userbyid(p.proowner),
           p.prosecdef,
           p.proconfig,
           p.proacl
      INTO function_owner_oid,
           function_owner,
           function_is_definer,
           function_config,
           function_acl
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid = function_oid;

    IF function_owner <> 'postgres' OR NOT function_is_definer THEN
      RAISE EXCEPTION
        'Phase A postcondition: owner/security-definer drift for %',
        expected.signature;
    END IF;

    IF function_config IS DISTINCT FROM ARRAY['search_path=""']::text[] THEN
      RAISE EXCEPTION
        'Phase A postcondition: unsafe function config for %, found %',
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
        'Phase A postcondition: effective ACL is not service-role-only for %',
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
        'Phase A postcondition: unexpected grantee/grantor/grant option for %, raw ACL %',
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
      'Phase A postcondition: increment_loyalty_points was not safely qualified';
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
      'Phase A postcondition: default function ACL is not fail-closed, found %',
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
      'Phase A postcondition: unexpected privilege/grant option/grantor in public default ACL';
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
      'Phase A postcondition: global function default ACL is not fail-closed, found %',
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
      'Phase A postcondition: unexpected privilege/grant option/grantor in global default ACL';
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
      'Phase A postcondition: refund status constraint was not widened safely, found %',
      refund_statuses;
  END IF;
END
$phase_a_postconditions$;

COMMIT;

-- Rollback is intentionally separate and approval-gated:
--   supabase/rollbacks/20260715000000_phase_a_capability_containment.rollback.sql
