-- Add allergens and nutrition facts columns to products table
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS allergens_json jsonb,
  ADD COLUMN IF NOT EXISTS nutrition_facts_json jsonb;

COMMENT ON COLUMN public.products.allergens_json IS 'Array of allergen objects from Foodics: [{id, name, image}]';
COMMENT ON COLUMN public.products.nutrition_facts_json IS 'Nutrition facts from Foodics: {calories, protein_g, fat_g, carbs_g, sugar_g, sodium_mg, serving_size, serving_unit}';
