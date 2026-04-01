-- 1. Localized names (Arabic) for products, categories, and branches
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS name_localized text DEFAULT NULL;

ALTER TABLE product_categories
  ADD COLUMN IF NOT EXISTS name_localized text DEFAULT NULL;

ALTER TABLE branch_mappings
  ADD COLUMN IF NOT EXISTS name_localized text DEFAULT NULL;

-- 2. Branch working hours and promising times
ALTER TABLE branch_mappings
  ADD COLUMN IF NOT EXISTS open_from text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS open_till text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pickup_promising_time integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS delivery_promising_time integer DEFAULT NULL;

COMMENT ON COLUMN branch_mappings.open_from IS 'Opening hour (e.g. "8" for 8 AM). From Foodics.';
COMMENT ON COLUMN branch_mappings.open_till IS 'Closing hour (e.g. "23" for 11 PM, or "2" for 2 AM next day). From Foodics.';
COMMENT ON COLUMN branch_mappings.pickup_promising_time IS 'Estimated pickup prep time in minutes. From Foodics.';
COMMENT ON COLUMN branch_mappings.delivery_promising_time IS 'Estimated delivery prep time in minutes. From Foodics.';
