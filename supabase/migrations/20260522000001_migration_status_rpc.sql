-- Public RPC that exposes the supabase_migrations.schema_migrations
-- table summary to the server. supabase-js's REST proxy is restricted
-- to the `public` schema by default; without this RPC the server can't
-- read the migration tracking table for drift detection.
--
-- SECURITY DEFINER so the function runs with the migration-owner role
-- (which has read access to supabase_migrations). We restrict EXECUTE
-- to the service_role only so customer-scope JWTs can't enumerate
-- migration history.
--
-- Used by:
--   server/utils/migrationStatus.ts → drift-detection check at boot
--                                     and on every /ready hit.

CREATE OR REPLACE FUNCTION public.get_migration_status()
RETURNS TABLE (
  latest_version text,
  latest_name text,
  total_applied bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, supabase_migrations
AS $$
  SELECT
    (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1) AS latest_version,
    (SELECT name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1) AS latest_name,
    (SELECT count(*) FROM supabase_migrations.schema_migrations) AS total_applied;
$$;

REVOKE ALL ON FUNCTION public.get_migration_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_migration_status() TO service_role;
