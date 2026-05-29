-- Phase 0 (payment-hardening): non-negative cashback balance guard.
-- Parity with customer_wallet_balances.balance_halalas CHECK. loyalty_cashback_balances
-- previously had NO check, so a bug/bypass could drive a balance negative.
-- Applied to prod 2026-05-30 via Supabase Management API; this file is the VCS record.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loyalty_cashback_balance_nonneg') THEN
    ALTER TABLE public.loyalty_cashback_balances
      ADD CONSTRAINT loyalty_cashback_balance_nonneg CHECK (balance_sar >= 0);
  END IF;
END $$;
