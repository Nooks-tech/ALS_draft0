-- Rollback for 20260715200000_merchants_revoke_owner_write.sql
--
-- Restores the pre-fix (Supabase-default) write grants and the two permissive
-- UPDATE policies EXACTLY as they existed on Frankfurt before the fix (verified
-- live 2026-07-15). WARNING: applying this re-opens the merchant subscription
-- self-grant vulnerability — only use to unblock a regression, then re-apply
-- the forward migration once the real cause is understood.

SET statement_timeout = '30s';
SET lock_timeout = '5s';

GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.merchants TO anon;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.merchants TO authenticated;

-- Recreate verbatim (both were FOR UPDATE, applied TO public, USING only, no
-- WITH CHECK — this is precisely what made the self-grant possible).
CREATE POLICY "Owner can update own merchant" ON public.merchants
  FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "Users can update own merchant" ON public.merchants
  FOR UPDATE USING (auth.uid() = user_id);
