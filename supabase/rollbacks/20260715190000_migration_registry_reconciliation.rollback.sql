-- Guarded rollback for 20260715190000_migration_registry_reconciliation.sql.
--
-- The ledger and terminal repairs are durable evidence. This rollback refuses
-- to erase them. It only removes an empty, never-used registry scaffold when
-- none of the narrowly repaired catalog effects is present.

SET statement_timeout = '30s';
SET lock_timeout = '5s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('nooks:shared-schema-registry:v1', 0)
);

DO $rollback_guard$
DECLARE
  durable_rows bigint := 0;
  backfill_rows_exist boolean := false;
BEGIN
  IF pg_catalog.to_regclass('public.nooks_schema_manifests') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.nooks_schema_manifests'
      INTO durable_rows;
    IF durable_rows > 0 THEN
      RAISE EXCEPTION
        'refusing registry rollback: % immutable manifest row(s) are durable',
        durable_rows
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF pg_catalog.to_regclass('public.nooks_schema_releases') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.nooks_schema_releases'
      INTO durable_rows;
    IF durable_rows > 0 THEN
      RAISE EXCEPTION
        'refusing registry rollback: % immutable release row(s) are durable',
        durable_rows
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF pg_catalog.to_regclass('public.nooks_schema_effect_attestations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.nooks_schema_effect_attestations'
      INTO durable_rows;
    IF durable_rows > 0 THEN
      RAISE EXCEPTION
        'refusing registry rollback: % immutable effect attestation row(s) are durable',
        durable_rows
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF pg_catalog.to_regclass('public.idx_orders_branch') IS NOT NULL
     OR pg_catalog.to_regclass('public.idx_product_categories_merchant') IS NOT NULL
     OR pg_catalog.col_description(
          pg_catalog.to_regclass('public.branch_operations'),
          (
            SELECT attribute.attnum
              FROM pg_catalog.pg_attribute AS attribute
             WHERE attribute.attrelid =
               pg_catalog.to_regclass('public.branch_operations')
               AND attribute.attname = 'delivery_enabled'
               AND NOT attribute.attisdropped
          )
        ) IS NOT NULL
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
        ) IS NOT NULL
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
        ) IS NOT NULL THEN
    RAISE EXCEPTION
      'refusing registry rollback: terminal repair effects are durable and are never dropped'
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.to_regclass('public.merchant_customers') IS NOT NULL THEN
    EXECUTE $query$
      SELECT EXISTS (
        SELECT 1
          FROM public.merchant_customers
         WHERE enrolled_via = 'back_populated'
      )
    $query$ INTO backfill_rows_exist;

    IF backfill_rows_exist THEN
      RAISE EXCEPTION
        'refusing registry rollback: merchant_customers backfill rows are durable and are never deleted'
        USING ERRCODE = '55000';
    END IF;
  END IF;
END
$rollback_guard$;

DROP FUNCTION IF EXISTS public.attest_nooks_schema_deployment(text, jsonb);
DROP FUNCTION IF EXISTS public.get_migration_status();

DROP TABLE IF EXISTS public.nooks_schema_effect_attestations;
DROP TABLE IF EXISTS public.nooks_schema_releases;
DROP TABLE IF EXISTS public.nooks_schema_manifests;
DROP FUNCTION IF EXISTS public.reject_nooks_schema_registry_mutation();

CREATE FUNCTION public.get_migration_status()
RETURNS TABLE (
  latest_version text,
  latest_name text,
  total_applied bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT
    (
      SELECT migration.version
        FROM supabase_migrations.schema_migrations AS migration
       ORDER BY migration.version DESC
       LIMIT 1
    ),
    (
      SELECT migration.name
        FROM supabase_migrations.schema_migrations AS migration
       ORDER BY migration.version DESC
       LIMIT 1
    ),
    (
      SELECT pg_catalog.count(*)
        FROM supabase_migrations.schema_migrations
    );
$function$;

REVOKE ALL ON FUNCTION public.get_migration_status()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_migration_status()
  TO service_role;

RESET lock_timeout;
RESET statement_timeout;
