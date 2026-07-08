-- Phase 1 — close live anon-readable RLS leaks (audit 2026-07-07: H1, H2, L1)
-- Applied to live DB (setynlgmdzaceegrlgwg) 2026-07-08; this file is the version-controlled record.
-- Verified: anon SELECT on all three tables returned [] after apply; authenticated self-reads unaffected.

-- H1: profiles "Profiles are viewable by everyone" was SELECT {public} USING(true) → leaked every phone_number.
-- Server dashboard reads use service_role (bypasses RLS); customers still read their own row.
ALTER POLICY "Profiles are viewable by everyone" ON public.profiles USING (auth.uid() = id);

-- H2: push_subscriptions "Service role can manage push subscriptions" was ALL {public} true/true (mis-scoped)
-- → anon could read every Expo token across both merchants + latent full CRUD. Re-scope to service_role
-- and add an authenticated self-read for the mobile app (app/(tabs)/more.tsx reads its own rows).
-- Owner column is customer_id (register route enforces customerId === authUserId); user_id mirrors it.
ALTER POLICY "Service role can manage push subscriptions" ON public.push_subscriptions TO service_role;
CREATE POLICY "push_sub_self_read" ON public.push_subscriptions
  FOR SELECT TO authenticated
  USING ((auth.uid())::text = customer_id);

-- L1: loyalty_customer_transitions "Service role full access" was ALL {public} true/true (mis-scoped).
-- Sole writer is the server (loyalty.ts, service_role); no client reads it.
ALTER POLICY "Service role full access" ON public.loyalty_customer_transitions TO service_role;

-- ROLLBACK (from Phase 0 snapshot):
--   ALTER POLICY "Profiles are viewable by everyone" ON public.profiles USING (true);
--   ALTER POLICY "Service role can manage push subscriptions" ON public.push_subscriptions TO public;
--   DROP POLICY IF EXISTS "push_sub_self_read" ON public.push_subscriptions;
--   ALTER POLICY "Service role full access" ON public.loyalty_customer_transitions TO public;
