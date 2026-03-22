-- Apple Wallet strip logo size (20–200%), independent from in-app header when set.
-- NULL = inherit app_config.in_app_logo_scale (legacy behavior).

ALTER TABLE public.loyalty_config
  ADD COLUMN IF NOT EXISTS wallet_card_logo_scale integer
  CHECK (wallet_card_logo_scale IS NULL OR (wallet_card_logo_scale >= 20 AND wallet_card_logo_scale <= 200));

COMMENT ON COLUMN public.loyalty_config.wallet_card_logo_scale IS
  'Wallet pass logo scale % (20–200). NULL = use app_config.in_app_logo_scale.';
