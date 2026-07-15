-- 20260715200000: close the merchant subscription self-grant.
--
-- FINDING (2026-07-15 security sweep, CONFIRMED live on Frankfurt):
--   A merchant owner can grant themselves a permanent free subscription and
--   zero payment-processing fees by PATCHing their OWN row directly via
--   PostgREST:
--     PATCH /rest/v1/merchants?id=eq.<own-id>
--     Authorization: Bearer <own JWT>   apikey: <public anon key>
--     {"trial_ends_at":"2099-01-01T00:00:00Z"}
--   merchants.trial_ends_at is the sole gate for the trial branch in
--   getMerchantSubscriptionPolicy (state:'trial' => orderIntake/build/storefront
--   all enabled) AND independently zeroes the web-checkout payment-processing
--   fee. The write is permitted by two things stacking:
--     1. the Supabase-default broad column UPDATE grant to `authenticated`, and
--     2. two column-unrestricted, WITH-CHECK-less RLS UPDATE policies
--        ("Owner can update own merchant", "Users can update own merchant").
--
-- FIX: authenticated/anon need NO write access to merchants at all. Every
-- legitimate merchants write in the codebase goes through the service-role
-- client (supabaseAdmin), which has rolbypassrls=true and its own grants, so it
-- is unaffected by this revoke. (Verified 2026-07-15: zero user-context
-- UPDATE/INSERT/UPSERT against public.merchants anywhere in nooksweb.)
--
--   * REVOKE the write privileges from anon + authenticated (the load-bearing
--     fix: no grant => no PostgREST write, regardless of any RLS policy).
--   * DROP the two redundant permissive UPDATE policies so that a future
--     accidental re-GRANT cannot silently re-open owner self-service writes.
--
-- SELECT (owner/team/public reads) and the service-role path are untouched.
-- Reversible: see supabase/rollbacks/20260715200000_merchants_revoke_owner_write.rollback.sql

SET statement_timeout = '30s';
SET lock_timeout = '5s';

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.merchants FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.merchants FROM authenticated;

DROP POLICY IF EXISTS "Owner can update own merchant" ON public.merchants;
DROP POLICY IF EXISTS "Users can update own merchant" ON public.merchants;

-- Post-conditions (advisory; not asserted here to keep the migration idempotent
-- under re-run):
--   has_table_privilege('authenticated','public.merchants','UPDATE') = false
--   has_table_privilege('anon','public.merchants','UPDATE')          = false
--   0 UPDATE policies remain on public.merchants
