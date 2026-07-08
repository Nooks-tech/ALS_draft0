-- Phase 4 — revoke anon/authenticated write grants on ledger/key tables (audit 2026-07-07: M3)
-- Applied to live DB (setynlgmdzaceegrlgwg) 2026-07-08; this file is the version-controlled record.
--
-- M3: these seven tables carried full INSERT/UPDATE/DELETE/TRUNCATE to anon+authenticated;
-- writes were denied today only by the absence of a permissive RLS policy — one accidental
-- policy away from exposing keys/balances (exactly what happened to push_subscriptions /
-- loyalty_customer_transitions before Phase 1). Defense-in-depth: remove the write grants so
-- a future stray policy can't matter. service_role bypasses RLS/grants, so server writes are
-- unaffected; SELECT grants are kept (RLS still gates actual row visibility).
--
-- Pre-check (blocking gate) result: no client (ALS app/+src/, nooksweb client components)
-- writes any of these tables — all writers are server-side supabaseAdmin/service_role.
-- Verified after apply: no INSERT/UPDATE/DELETE/TRUNCATE grants remain for anon/authenticated;
-- SELECT grants intact; anon INSERT -> 42501 permission denied.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  public.merchant_payment_settings,
  public.customer_wallet_balances,
  public.customer_wallet_transactions,
  public.loyalty_points,
  public.loyalty_cashback_balances,
  public.subscriptions,
  public.merchant_sms_wallets
FROM anon, authenticated;

-- ROLLBACK (re-grant from the Phase 0 grants snapshot):
--   GRANT INSERT, UPDATE, DELETE, TRUNCATE ON
--     public.merchant_payment_settings, public.customer_wallet_balances,
--     public.customer_wallet_transactions, public.loyalty_points,
--     public.loyalty_cashback_balances, public.subscriptions, public.merchant_sms_wallets
--   TO anon, authenticated;
