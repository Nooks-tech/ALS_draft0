-- Transactional negative/positive behavior checks for the collision-safe
-- migration registry. No durable rows are changed.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

DO $registry_semantic_test$
DECLARE
  rejected boolean;
  status_row record;
  deployment_sha text;
  deployment_rows jsonb;
  before_release_count bigint;
  after_release_count bigint;
BEGIN
  rejected := false;
  BEGIN
    UPDATE public.nooks_schema_manifests
       SET authority_repository = 'WEB'
     WHERE manifest_sha256 =
       'd939264176fe1ff360c27cb2b56b83cefc23bc5b29a3ac55ff1dfb1c6f233493';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN
      rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'registry semantic test: immutable manifest update succeeded';
  END IF;

  rejected := false;
  BEGIN
    DELETE FROM public.nooks_schema_releases
     WHERE repository = 'ALS'
       AND migration_version = '20260216000000';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN
      rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'registry semantic test: immutable release delete succeeded';
  END IF;

  rejected := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM * FROM public.get_migration_status();
  EXCEPTION
    WHEN insufficient_privilege THEN
      rejected := true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT rejected THEN
    RAISE EXCEPTION 'registry semantic test: anon executed get_migration_status';
  END IF;

  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT * INTO status_row FROM public.get_migration_status();
  EXECUTE 'RESET ROLE';

  IF status_row.manifest_complete IS DISTINCT FROM true
     OR status_row.hashes_valid IS DISTINCT FROM true
     OR status_row.deployment_attestation_complete IS DISTINCT FROM true
     OR status_row.pending_unproven IS DISTINCT FROM 42::bigint THEN
    RAISE EXCEPTION 'registry semantic test: service status response differs';
  END IF;

  rejected := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
    PERFORM pg_catalog.count(*) FROM public.nooks_schema_releases;
  EXCEPTION
    WHEN insufficient_privilege THEN
      rejected := true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT rejected THEN
    RAISE EXCEPTION 'registry semantic test: service_role read ledger directly';
  END IF;

  SELECT
    manifest.manifest_sha256,
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'version', release.migration_version,
        'name', release.migration_name,
        'sha256', release.source_sha256
      )
      ORDER BY release.migration_version, release.migration_name, release.source_sha256
    )
    INTO deployment_sha, deployment_rows
    FROM public.nooks_schema_manifests AS manifest
    JOIN public.nooks_schema_releases AS release
      ON release.manifest_sha256 = manifest.manifest_sha256
   WHERE manifest.manifest_kind = 'deployment'
   GROUP BY manifest.manifest_sha256;

  IF deployment_sha IS NULL
     OR pg_catalog.jsonb_array_length(deployment_rows) <> 4 THEN
    RAISE EXCEPTION 'registry semantic test: deployment fixture is absent';
  END IF;

  SELECT pg_catalog.count(*)
    INTO before_release_count
    FROM public.nooks_schema_releases;

  PERFORM *
    FROM public.attest_nooks_schema_deployment(
      deployment_sha,
      deployment_rows
    );

  SELECT pg_catalog.count(*)
    INTO after_release_count
    FROM public.nooks_schema_releases;

  IF after_release_count <> before_release_count THEN
    RAISE EXCEPTION 'registry semantic test: idempotent attestation appended rows';
  END IF;

  rejected := false;
  BEGIN
    PERFORM *
      FROM public.attest_nooks_schema_deployment(
        pg_catalog.repeat('0', 64),
        deployment_rows
      );
  EXCEPTION
    WHEN raise_exception THEN
      rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'registry semantic test: incorrect deployment digest succeeded';
  END IF;

  rejected := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
    PERFORM *
      FROM public.attest_nooks_schema_deployment(
        deployment_sha,
        deployment_rows
      );
  EXCEPTION
    WHEN insufficient_privilege THEN
      rejected := true;
  END;
  EXECUTE 'RESET ROLE';
  IF NOT rejected THEN
    RAISE EXCEPTION 'registry semantic test: service_role appended an attestation';
  END IF;
END
$registry_semantic_test$;

ROLLBACK;

