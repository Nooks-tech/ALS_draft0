-- Add preferred_carriers column to merchant_delivery_settings
-- Comma-separated carrier names (e.g. "careem,mrsool,dal"). NULL = use platform default from OTO_PREFERRED_CARRIERS env.
ALTER TABLE merchant_delivery_settings
  ADD COLUMN IF NOT EXISTS preferred_carriers text DEFAULT NULL;

COMMENT ON COLUMN merchant_delivery_settings.preferred_carriers
  IS 'Comma-separated OTO carrier filter (e.g. careem,mrsool,dal). NULL = platform default.';
