-- Rollback for 20260715210000_revoke_qr_scan_count_exec.sql
-- Restores the pre-fix (Supabase-default) EXECUTE grants. WARNING: this re-opens
-- the anon scan-count inflation vector (analytics only).

SET statement_timeout = '30s';
SET lock_timeout = '5s';

-- Original state had the default PUBLIC grant (which anon/authenticated inherit).
GRANT EXECUTE ON FUNCTION public.increment_qr_scan_count(uuid) TO PUBLIC;
