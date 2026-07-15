-- Read-only catalog/data postconditions for 20260715170000.
-- Safe against production: this script performs no writes.

BEGIN READ ONLY;

DO $phase_c_catalog_test$
DECLARE
  expected_table_name text;
  function_signature text;
  function_oid oid;
  function_config text[];
  function_owner text;
  function_security_definer boolean;
  untrusted_table_grants bigint;
  conservation_failures bigint;
BEGIN
  FOREACH expected_table_name IN ARRAY ARRAY[
    'phase_c_runtime_controls', 'phase_c_legacy_value_classifications',
    'loyalty_program_versions', 'wallet_accounts', 'wallet_entries',
    'wallet_reservations', 'loyalty_accounts', 'loyalty_entries',
    'loyalty_value_reservations', 'loyalty_milestone_products',
    'reward_reservations', 'promo_reservations', 'checkout_commits',
    'checkout_commit_outbox', 'phase_c_deprecated_paths'
  ]
  LOOP
    IF pg_catalog.to_regclass('public.' || expected_table_name) IS NULL THEN
      RAISE EXCEPTION 'Phase C catalog test: missing public.%', expected_table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS c
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = expected_table_name AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'Phase C catalog test: RLS disabled on public.%', expected_table_name;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM public.phase_c_runtime_controls) <> 1
     OR EXISTS (
       SELECT 1 FROM public.phase_c_runtime_controls
        WHERE wallet_commands_enabled OR loyalty_commands_enabled OR promo_commands_enabled
           OR reward_reservations_enabled OR checkout_commit_enabled
           OR reservation_expiry_worker_enabled OR foodics_type2_rewards_enabled
           OR NOT legacy_compatibility_writes_enabled
     ) THEN
    RAISE EXCEPTION 'Phase C catalog test: foundation flags are not dormant';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.loyalty_program_versions
     WHERE status <> 'legacy_import' OR reward_reservations_enabled
        OR cashback_reservations_enabled OR foodics_type2_enabled
  ) OR EXISTS (
    SELECT 1 FROM public.loyalty_milestone_products WHERE is_active
  ) THEN
    RAISE EXCEPTION 'Phase C catalog test: imported loyalty capability is active';
  END IF;

  IF (SELECT count(*) FROM public.phase_c_legacy_value_classifications
       WHERE value_domain = 'points' AND review_state = 'requires_review' AND delta_amount = 10) <> 1
     OR (SELECT count(*) FROM public.phase_c_legacy_value_classifications
       WHERE value_domain = 'cashback_halala' AND review_state = 'requires_review' AND delta_amount = -1510) <> 1
     OR EXISTS (
       SELECT 1 FROM public.phase_c_legacy_value_classifications
        WHERE review_state = 'requires_review' AND delta_amount NOT IN (10, -1510)
     ) THEN
    RAISE EXCEPTION 'Phase C catalog test: legacy epoch classification drift';
  END IF;

  SELECT count(*) INTO conservation_failures
    FROM public.phase_c_value_conservation() WHERE NOT conservation_ok;
  IF conservation_failures <> 0 THEN
    RAISE EXCEPTION 'Phase C catalog test: conservation failures %', conservation_failures;
  END IF;

  IF EXISTS (SELECT 1 FROM public.wallet_reservations)
     OR EXISTS (SELECT 1 FROM public.loyalty_value_reservations)
     OR EXISTS (SELECT 1 FROM public.reward_reservations)
     OR EXISTS (SELECT 1 FROM public.promo_reservations)
     OR EXISTS (SELECT 1 FROM public.checkout_commits)
     OR EXISTS (SELECT 1 FROM public.checkout_commit_outbox) THEN
    RAISE EXCEPTION 'Phase C catalog test: dormant foundation contains runtime work';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.phase_c_deprecated_paths
     WHERE prefix_authorizes_value
  ) OR NOT EXISTS (
    SELECT 1 FROM public.phase_c_deprecated_paths
     WHERE path_key = 'Foodics Type 1 points discount'
       AND compatibility_state = 'removed'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.phase_c_deprecated_paths
     WHERE path_key = 'Foodics Type 2 adapter reward'
       AND compatibility_state = 'blocked_after_cutover'
  ) THEN
    RAISE EXCEPTION 'Phase C catalog test: reward/prefix deprecation contract failed';
  END IF;

  FOREACH function_signature IN ARRAY ARRAY[
    'public.credit_wallet_from_topup_intent(uuid)',
    'public.reserve_wallet_for_attempt(uuid,uuid,text)',
    'public.reserve_cashback_for_attempt(uuid,uuid,text)',
    'public.reserve_reward_for_attempt(uuid,uuid,uuid,integer,text)',
    'public.reserve_promo_for_attempt(uuid,uuid,text)',
    'public.release_attempt_reservations(uuid,text)',
    'public.expire_phase_c_reservations(integer)',
    'public.commit_checkout_with_reservations(uuid,uuid,text,text)',
    'public.phase_c_value_conservation()'
  ]
  LOOP
    function_oid := pg_catalog.to_regprocedure(function_signature);
    IF function_oid IS NULL THEN
      RAISE EXCEPTION 'Phase C catalog test: missing %', function_signature;
    END IF;
    SELECT pg_catalog.pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
      INTO function_owner, function_security_definer, function_config
      FROM pg_catalog.pg_proc AS p WHERE p.oid = function_oid;
    IF function_owner <> 'postgres' OR NOT function_security_definer
       OR function_config IS DISTINCT FROM ARRAY['search_path=""']::text[] THEN
      RAISE EXCEPTION 'Phase C catalog test: unsafe owner/definer/search_path for %', function_signature;
    END IF;
    IF pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc AS p,
           LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS acl
          WHERE p.oid = function_oid AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
       )
       OR NOT pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Phase C catalog test: command is not service-role-only: %', function_signature;
    END IF;
  END LOOP;

  SELECT count(*) INTO untrusted_table_grants
    FROM information_schema.table_privileges
   WHERE table_schema = 'public'
     AND table_name IN (
       'phase_c_runtime_controls', 'phase_c_legacy_value_classifications',
       'loyalty_program_versions', 'wallet_accounts', 'wallet_entries',
       'wallet_reservations', 'loyalty_accounts', 'loyalty_entries',
       'loyalty_value_reservations', 'loyalty_milestone_products',
       'reward_reservations', 'promo_reservations', 'checkout_commits',
       'checkout_commit_outbox', 'phase_c_deprecated_paths'
     )
     AND grantee IN ('PUBLIC', 'anon', 'authenticated');
  IF untrusted_table_grants <> 0 THEN
    RAISE EXCEPTION 'Phase C catalog test: untrusted table grants %', untrusted_table_grants;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.table_privileges
     WHERE table_schema = 'public'
       AND table_name IN (
         'wallet_accounts', 'wallet_entries', 'wallet_reservations',
         'loyalty_accounts', 'loyalty_entries', 'loyalty_value_reservations',
         'reward_reservations', 'promo_reservations', 'checkout_commits'
       )
       AND grantee = 'service_role'
       AND privilege_type <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'Phase C catalog test: service_role has direct value-table mutation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = 'public.wallet_entries'::regclass
       AND tgname = 'phase_c_wallet_entries_immutable' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = 'public.loyalty_entries'::regclass
       AND tgname = 'phase_c_loyalty_entries_immutable' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Phase C catalog test: immutable ledger trigger missing';
  END IF;
END
$phase_c_catalog_test$;

ROLLBACK;
