-- Phase L11 — wallet balance-vs-ledger reconciliation RPC (audit 2026-07-07: L10/L11)
-- Applied to live DB (setynlgmdzaceegrlgwg) 2026-07-08; version-controlled record.
--
-- Returns any (customer,merchant) whose customer_wallet_balances.balance_halalas
-- diverges from SUM(customer_wallet_transactions.amount_halalas) — i.e. a balance
-- written directly, bypassing credit_/debit_customer_wallet. The daily loyalty cron
-- (server/cron/loyaltyExpiration.ts reconcileWalletBalances) calls this and
-- captureError()s any mismatch. Wallet is the only balance with no expiry, so its
-- ledger sum is exact and this never false-positives.
-- (The 2026-07-08 phantom test grant ed74e126 (500 SAR, no ledger) was reconciled to
--  0 the same day, so this returns [] at ship time.)
-- Points/cashback reconciliation needs expiry-aware logic — separate follow-up.

CREATE OR REPLACE FUNCTION public.wallet_balance_mismatches()
RETURNS TABLE(customer_id uuid, merchant_id uuid, balance_halalas bigint, ledger_halalas bigint)
LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
  SELECT b.customer_id, b.merchant_id, b.balance_halalas,
         COALESCE((SELECT SUM(t.amount_halalas) FROM public.customer_wallet_transactions t
                   WHERE t.customer_id = b.customer_id AND t.merchant_id = b.merchant_id), 0)::bigint
  FROM public.customer_wallet_balances b
  WHERE b.balance_halalas <> COALESCE((SELECT SUM(t.amount_halalas) FROM public.customer_wallet_transactions t
                   WHERE t.customer_id = b.customer_id AND t.merchant_id = b.merchant_id), 0);
$fn$;

-- ROLLBACK: DROP FUNCTION IF EXISTS public.wallet_balance_mismatches();
