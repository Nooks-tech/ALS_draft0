-- Add max cashback per order cap to loyalty config
ALTER TABLE public.loyalty_config
  ADD COLUMN IF NOT EXISTS max_cashback_per_order_sar numeric;

COMMENT ON COLUMN public.loyalty_config.max_cashback_per_order_sar IS 'Maximum SAR cashback redeemable per order. NULL = no cap.';
