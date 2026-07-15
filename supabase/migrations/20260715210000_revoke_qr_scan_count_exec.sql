-- 20260715210000: least-privilege — stop anon/authenticated executing the
-- SECURITY DEFINER increment_qr_scan_count.
--
-- FINDING (2026-07-15 security sweep, LOW — CONFIRMED live on Frankfurt):
--   public.increment_qr_scan_count(qr_id uuid) is SECURITY DEFINER with EXECUTE
--   granted to anon AND authenticated, and its body
--     UPDATE public.merchant_qr_codes SET scan_count = scan_count + 1 WHERE id = qr_id
--   has no ownership/role check. Anyone with the public anon key can POST to
--   /rest/v1/rpc/increment_qr_scan_count with any qr uuid in a loop and inflate
--   a merchant's scan_count (analytics-only, no money/PII, hence LOW).
--
-- The only caller is server-side and already uses supabaseAdmin (service_role,
-- which has rolbypassrls=true), so revoking the anon/authenticated EXECUTE grant
-- is a pure least-privilege cleanup with ZERO behavior change on the real path.
-- Reversible: supabase/rollbacks/20260715210000_revoke_qr_scan_count_exec.rollback.sql

SET statement_timeout = '30s';
SET lock_timeout = '5s';

-- The leak is the DEFAULT PUBLIC grant (proacl `=X/postgres`), which anon and
-- authenticated inherit — revoking from the named roles alone does nothing.
-- Revoke PUBLIC (and the named roles explicitly, matching the Phase A idiom).
-- service_role keeps its own explicit EXECUTE grant, so the real caller is
-- unaffected — the resulting ACL matches the correctly-locked money RPCs
-- (e.g. redeem_loyalty_points: {postgres, service_role} only).
REVOKE EXECUTE ON FUNCTION public.increment_qr_scan_count(uuid) FROM PUBLIC, anon, authenticated;

-- Post-condition (advisory):
--   has_function_privilege('anon', 'public.increment_qr_scan_count(uuid)','EXECUTE')          = false
--   has_function_privilege('authenticated','public.increment_qr_scan_count(uuid)','EXECUTE')  = false
--   has_function_privilege('service_role','public.increment_qr_scan_count(uuid)','EXECUTE')   = true
