-- Read-only catalog and terminal-state verification for
-- 20260715190000_migration_registry_reconciliation.sql.
--
-- Run after the postgres-only deployment attestation has appended finalized
-- hashes for 160000, 170000, 180000, and 190000.

\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

DO $registry_catalog_test$
DECLARE
  status_row record;
  actual_digest text;
  expected record;
  function_oid oid;
  function_owner oid;
  function_config text[];
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM public.nooks_schema_manifests
  ) <> 2 THEN
    RAISE EXCEPTION 'registry test: expected historical + deployment manifests';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.nooks_schema_manifests AS manifest
     WHERE manifest.manifest_sha256 =
       'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493'
       AND manifest.manifest_kind = 'historical_inventory'
       AND manifest.inventory_row_count = 153
       AND manifest.authority_repository = 'ALS'
       AND manifest.source_project_ref = 'rmslvptafkxywhpzpuxt'
       AND manifest.expected_registered_exact = 62
       AND manifest.expected_live_effect_attested = 45
       AND manifest.expected_superseded_obsolete = 4
       AND manifest.expected_pending_unproven = 42
  ) THEN
    RAISE EXCEPTION 'registry test: baseline manifest metadata is divergent';
  END IF;

  SELECT pg_catalog.encode(
           extensions.digest(
             pg_catalog.convert_to(
               pg_catalog.string_agg(
                 release.repository || '|' || release.migration_version || '|'
                   || release.migration_name || '|' || release.source_sha256
                   || '|' || release.inventory_status,
                 E'\n'
                 ORDER BY release.inventory_ordinal
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         )
    INTO actual_digest
    FROM public.nooks_schema_releases AS release
   WHERE release.manifest_sha256 =
     'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493';

  IF actual_digest <>
       'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493' THEN
    RAISE EXCEPTION 'registry test: baseline logical digest mismatch: %', actual_digest;
  END IF;

  IF (
    SELECT ARRAY[
      pg_catalog.count(*) FILTER (
        WHERE release.attestation_status = 'registered_exact'
      )::integer,
      pg_catalog.count(*) FILTER (
        WHERE release.attestation_status = 'live_effect_attested'
      )::integer,
      pg_catalog.count(*) FILTER (
        WHERE release.attestation_status = 'superseded_obsolete'
      )::integer,
      pg_catalog.count(*) FILTER (
        WHERE release.attestation_status = 'pending_unproven'
      )::integer
    ]
      FROM public.nooks_schema_releases AS release
     WHERE release.manifest_sha256 =
       'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493'
  ) IS DISTINCT FROM ARRAY[62, 45, 4, 42] THEN
    RAISE EXCEPTION 'registry test: baseline reconciliation status counts differ';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM public.nooks_schema_releases AS release
     WHERE release.manifest_sha256 =
       'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493'
  ) <> 153
  OR (
    SELECT pg_catalog.count(DISTINCT release.migration_version)
      FROM public.nooks_schema_releases AS release
     WHERE release.manifest_sha256 =
       'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493'
  ) <> 141 THEN
    RAISE EXCEPTION 'registry test: baseline collision-safe cardinality differs';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM public.nooks_schema_releases AS release
     WHERE release.manifest_sha256 =
       'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493'
       AND release.inventory_status = 'REGISTERED_NAME_MATCH'
       AND release.migration_version = ANY (ARRAY[
         '20260408000000',
         '20260417000000',
         '20260418000000',
         '20260418000001',
         '20260418000002'
       ])
       AND release.attestation_status = 'pending_unproven'
       AND release.evidence_code = 'inventory_only'
       AND release.attested_at IS NULL
  ) <> 10 THEN
    RAISE EXCEPTION
      'registry test: same-version/same-name source-hash ambiguity was hidden';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.nooks_schema_releases AS release
     WHERE (
       release.attestation_status = 'registered_exact'
       AND (
         release.inventory_status <> 'REGISTERED_NAME_MATCH'
         OR release.evidence_code <> 'registry_identity_match'
         OR release.attested_at IS NULL
       )
     )
     OR (
       release.attestation_status = 'pending_unproven'
       AND (
         release.evidence_code <> 'inventory_only'
         OR release.attested_at IS NOT NULL
       )
     )
  ) THEN
    RAISE EXCEPTION 'registry test: a release overstates its evidence';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM public.nooks_schema_manifests AS manifest
     WHERE manifest.manifest_kind = 'deployment'
       AND manifest.inventory_row_count = 4
       AND manifest.expected_registered_exact = 0
       AND manifest.expected_live_effect_attested = 4
       AND manifest.expected_superseded_obsolete = 0
       AND manifest.expected_pending_unproven = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'registry test: finalized four-release deployment manifest is absent';
  END IF;

  IF (
    SELECT pg_catalog.array_agg(
             release.migration_version
             ORDER BY release.migration_version
           )
      FROM public.nooks_schema_releases AS release
      JOIN public.nooks_schema_manifests AS manifest
        ON manifest.manifest_sha256 = release.manifest_sha256
     WHERE manifest.manifest_kind = 'deployment'
       AND release.repository = 'ALS'
       AND release.inventory_status = 'AUTHORITATIVE_DEPLOYMENT'
       AND release.attestation_status = 'live_effect_attested'
       AND release.evidence_code = 'authoritative_deployment_attestation'
  ) IS DISTINCT FROM ARRAY[
    '20260715160000',
    '20260715170000',
    '20260715180000',
    '20260715190000'
  ]::text[] THEN
    RAISE EXCEPTION 'registry test: current authoritative deployment versions differ';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.nooks_schema_manifests AS manifest
     WHERE manifest.manifest_kind = 'deployment'
       AND manifest.manifest_sha256 <> (
         SELECT pg_catalog.encode(
                  extensions.digest(
                    pg_catalog.convert_to(
                      pg_catalog.string_agg(
                        release.repository || '|' || release.migration_version || '|'
                          || release.migration_name || '|' || release.source_sha256
                          || '|' || release.inventory_status,
                        E'\n'
                        ORDER BY release.inventory_ordinal
                      ),
                      'UTF8'
                    ),
                    'sha256'
                  ),
                  'hex'
                )
           FROM public.nooks_schema_releases AS release
          WHERE release.manifest_sha256 = manifest.manifest_sha256
       )
  ) THEN
    RAISE EXCEPTION 'registry test: deployment manifest digest mismatch';
  END IF;

  SELECT *
    INTO status_row
    FROM public.get_migration_status();

  IF status_row.manifest_sha256 IS DISTINCT FROM
       'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493'
     OR status_row.authority_repository IS DISTINCT FROM 'ALS'
     OR status_row.total_inventory IS DISTINCT FROM 157::bigint
     OR status_row.registered_exact IS DISTINCT FROM 62::bigint
     OR status_row.live_effect_attested IS DISTINCT FROM 49::bigint
     OR status_row.superseded_obsolete IS DISTINCT FROM 4::bigint
     OR status_row.pending_unproven IS DISTINCT FROM 42::bigint
     OR status_row.manifest_count IS DISTINCT FROM 2::bigint
     OR status_row.manifest_complete IS DISTINCT FROM true
     OR status_row.hashes_valid IS DISTINCT FROM true
     OR status_row.authoritative_release_count IS DISTINCT FROM 4::bigint
     OR status_row.deployment_attestation_complete IS DISTINCT FROM true
     OR status_row.authoritative_manifest_sha256 IS NULL THEN
    RAISE EXCEPTION 'registry test: get_migration_status is not manifest-aware: %',
      pg_catalog.row_to_json(status_row);
  END IF;

  function_oid := pg_catalog.to_regprocedure('public.get_migration_status()');
  SELECT procedure.proowner, procedure.proconfig
    INTO function_owner, function_config
    FROM pg_catalog.pg_proc AS procedure
   WHERE procedure.oid = function_oid
     AND procedure.prosecdef;

  IF NOT FOUND
     OR pg_catalog.pg_get_userbyid(function_owner) <> 'postgres'
     OR function_config IS DISTINCT FROM ARRAY['search_path=""']::text[]
     OR pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'registry test: get_migration_status is not postgres-owned and service-only';
  END IF;

  function_oid := pg_catalog.to_regprocedure(
    'public.attest_nooks_schema_deployment(text,jsonb)'
  );
  SELECT procedure.proowner, procedure.proconfig
    INTO function_owner, function_config
    FROM pg_catalog.pg_proc AS procedure
   WHERE procedure.oid = function_oid
     AND NOT procedure.prosecdef;

  IF NOT FOUND
     OR pg_catalog.pg_get_userbyid(function_owner) <> 'postgres'
     OR function_config IS NULL
     OR NOT function_config @> ARRAY[
       'search_path=""',
       'lock_timeout=5s',
       'statement_timeout=30s'
     ]::text[]
     OR pg_catalog.cardinality(function_config) <> 3
     OR pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'registry test: deployment attestation is not postgres-only';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = ANY (ARRAY[
         'nooks_schema_manifests',
         'nooks_schema_releases',
         'nooks_schema_effect_attestations'
       ])
       AND relation.relrowsecurity
       AND relation.relforcerowsecurity
       AND NOT pg_catalog.has_table_privilege('service_role', relation.oid, 'SELECT')
       AND NOT pg_catalog.has_table_privilege('service_role', relation.oid, 'INSERT')
       AND NOT pg_catalog.has_table_privilege('service_role', relation.oid, 'UPDATE')
       AND NOT pg_catalog.has_table_privilege('service_role', relation.oid, 'DELETE')
       AND NOT pg_catalog.has_table_privilege('anon', relation.oid, 'SELECT')
       AND NOT pg_catalog.has_table_privilege('anon', relation.oid, 'INSERT')
       AND NOT pg_catalog.has_table_privilege('anon', relation.oid, 'UPDATE')
       AND NOT pg_catalog.has_table_privilege('anon', relation.oid, 'DELETE')
       AND NOT pg_catalog.has_table_privilege('authenticated', relation.oid, 'SELECT')
       AND NOT pg_catalog.has_table_privilege('authenticated', relation.oid, 'INSERT')
       AND NOT pg_catalog.has_table_privilege('authenticated', relation.oid, 'UPDATE')
       AND NOT pg_catalog.has_table_privilege('authenticated', relation.oid, 'DELETE')
  ) <> 3 THEN
    RAISE EXCEPTION 'registry test: ledger table RLS or direct ACL is too broad';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_trigger AS trigger
      JOIN pg_catalog.pg_proc AS procedure
        ON procedure.oid = trigger.tgfoid
     WHERE trigger.tgrelid = ANY (ARRAY[
       pg_catalog.to_regclass('public.nooks_schema_manifests'),
       pg_catalog.to_regclass('public.nooks_schema_releases'),
       pg_catalog.to_regclass('public.nooks_schema_effect_attestations')
     ])
       AND NOT trigger.tgisinternal
       AND procedure.proname = 'reject_nooks_schema_registry_mutation'
       AND (trigger.tgtype & 8) = 8
       AND (trigger.tgtype & 16) = 16
  ) <> 3 THEN
    RAISE EXCEPTION 'registry test: immutable ledger triggers are absent';
  END IF;

  FOR expected IN
    SELECT *
      FROM (VALUES
        ('public.idx_orders_branch', 'public.orders', 'branch_id'),
        (
          'public.idx_product_categories_merchant',
          'public.product_categories',
          'merchant_id'
        )
      ) AS inventory(index_name, table_name, column_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_index AS index_row
        JOIN pg_catalog.pg_class AS index_class
          ON index_class.oid = index_row.indexrelid
        JOIN pg_catalog.pg_am AS access_method
          ON access_method.oid = index_class.relam
       WHERE index_row.indexrelid = pg_catalog.to_regclass(expected.index_name)
         AND index_row.indrelid = pg_catalog.to_regclass(expected.table_name)
         AND index_row.indisvalid
         AND index_row.indisready
         AND NOT index_row.indisunique
         AND index_row.indpred IS NULL
         AND index_row.indexprs IS NULL
         AND index_row.indnkeyatts = 1
         AND pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true)
             = expected.column_name
         AND access_method.amname = 'btree'
    ) THEN
      RAISE EXCEPTION 'registry test: repaired index differs: %', expected.index_name;
    END IF;
  END LOOP;

  IF pg_catalog.col_description(
       pg_catalog.to_regclass('public.branch_operations'),
       (
         SELECT attribute.attnum
           FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid =
            pg_catalog.to_regclass('public.branch_operations')
            AND attribute.attname = 'delivery_enabled'
            AND NOT attribute.attisdropped
       )
     ) IS DISTINCT FROM
       'Whether the branch accepts delivery orders. Independent of the legacy delivery_mode enum which is kept for back-compat reads.'
  OR pg_catalog.col_description(
       pg_catalog.to_regclass('public.branch_operations'),
       (
         SELECT attribute.attnum
           FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid =
            pg_catalog.to_regclass('public.branch_operations')
            AND attribute.attname = 'pickup_enabled'
            AND NOT attribute.attisdropped
       )
     ) IS DISTINCT FROM
       'Whether the branch accepts in-store pickup orders.'
  OR pg_catalog.col_description(
       pg_catalog.to_regclass('public.branch_operations'),
       (
         SELECT attribute.attnum
           FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid =
            pg_catalog.to_regclass('public.branch_operations')
            AND attribute.attname = 'drivethru_enabled'
            AND NOT attribute.attisdropped
       )
     ) IS DISTINCT FROM
       'Whether the branch accepts curbside ("Receive from your car") orders. Mapped to Foodics pickup with car details in customer_notes.'
  THEN
    RAISE EXCEPTION 'registry test: repaired comments differ';
  END IF;

  IF EXISTS (
    WITH footprint AS (
      SELECT merchant_id::text, customer_id::text
        FROM public.loyalty_member_profiles
       WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL
      UNION
      SELECT merchant_id::text, customer_id::text
        FROM public.loyalty_points
       WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL
      UNION
      SELECT merchant_id::text, customer_id::text
        FROM public.loyalty_cashback_balances
       WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL
      UNION
      SELECT merchant_id::text, customer_id::text
        FROM public.customer_orders
       WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL
    )
    SELECT 1
      FROM footprint
      JOIN public.merchants AS merchant
        ON merchant.id::text = footprint.merchant_id
     WHERE footprint.merchant_id
             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND footprint.customer_id <> ''
       AND NOT EXISTS (
         SELECT 1
           FROM public.merchant_customers AS merchant_customer
          WHERE merchant_customer.merchant_id = merchant.id
            AND merchant_customer.customer_id = footprint.customer_id
       )
  ) THEN
    RAISE EXCEPTION 'registry test: merchant_customers footprint gap remains';
  END IF;

  IF pg_catalog.to_regclass('public.loyalty_stamp_redemptions') IS NOT NULL
     OR (
       SELECT pg_catalog.count(*)
         FROM public.nooks_schema_effect_attestations AS effect
        WHERE effect.effect_key LIKE
          'obsolete:public.loyalty_stamp_redemptions:%'
          AND effect.effect_status = 'superseded_obsolete'
     ) <> 3
     OR (
       SELECT pg_catalog.count(*)
         FROM public.nooks_schema_effect_attestations
     ) <> 9 THEN
    RAISE EXCEPTION 'registry test: terminal effect attestations differ';
  END IF;
END
$registry_catalog_test$;

ROLLBACK;
