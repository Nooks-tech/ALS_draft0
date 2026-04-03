-- Fix: loyalty_transactions type CHECK constraint missing 'expire'
-- The expiration cron inserts type='expire' but the original constraint only allows 'earn','redeem'
ALTER TABLE IF EXISTS public.loyalty_transactions DROP CONSTRAINT IF EXISTS loyalty_transactions_type_check;
ALTER TABLE IF EXISTS public.loyalty_transactions ADD CONSTRAINT loyalty_transactions_type_check CHECK (type IN ('earn', 'redeem', 'expire'));

-- Fix: stamp_number CHECK limits milestones to 1-10 despite configurable stamp_target
ALTER TABLE IF EXISTS public.loyalty_stamp_milestones DROP CONSTRAINT IF EXISTS loyalty_stamp_milestones_stamp_number_check;
ALTER TABLE IF EXISTS public.loyalty_stamp_milestones ADD CONSTRAINT loyalty_stamp_milestones_stamp_number_check CHECK (stamp_number >= 1 AND stamp_number <= 100);
