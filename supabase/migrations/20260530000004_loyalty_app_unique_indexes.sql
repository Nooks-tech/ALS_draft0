-- Phase 2 (#5/#6): atomic dedup for app-source loyalty earns + milestone
-- redeems. earnCashback already had the insert-first + 23505 catch but the
-- index never existed (only source='branch' was covered); earnPoints +
-- consumeOrderMilestones were reordered to insert-first to match. The
-- source='app' scope excludes refund-reversal rows (source='refund') and
-- branch rows (source='branch', which have their own index).

-- (1) One earn per (merchant, customer, order, loyalty_type) — points & cashback.
CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_transactions_app_earn_unique
  ON public.loyalty_transactions (merchant_id, customer_id, order_id, loyalty_type)
  WHERE source = 'app' AND type = 'earn' AND order_id IS NOT NULL;

-- (2) One milestone redeem per (merchant, customer, order, milestone).
CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_transactions_app_milestone_redeem_unique
  ON public.loyalty_transactions (merchant_id, customer_id, order_id, reference_id)
  WHERE source = 'app' AND type = 'redeem' AND reference_type = 'milestone' AND order_id IS NOT NULL;
