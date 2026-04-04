-- Remove 'points' as a user-visible loyalty type
-- Stamps use points internally (1 stamp = 1 point) but 'points' is no longer offered
ALTER TABLE IF EXISTS public.loyalty_config DROP CONSTRAINT IF EXISTS loyalty_config_loyalty_type_check;
ALTER TABLE IF EXISTS public.loyalty_config ADD CONSTRAINT loyalty_config_loyalty_type_check
  CHECK (loyalty_type IS NULL OR loyalty_type IN ('cashback', 'stamps'));

-- Update any existing 'points' configs to 'stamps' (since stamps = points internally)
UPDATE public.loyalty_config SET loyalty_type = 'stamps' WHERE loyalty_type = 'points';

-- Same for member profiles
ALTER TABLE IF EXISTS public.loyalty_member_profiles DROP CONSTRAINT IF EXISTS loyalty_member_profiles_active_type_check;
ALTER TABLE IF EXISTS public.loyalty_member_profiles ADD CONSTRAINT loyalty_member_profiles_active_type_check
  CHECK (active_loyalty_type IS NULL OR active_loyalty_type IN ('cashback', 'stamps'));
UPDATE public.loyalty_member_profiles SET active_loyalty_type = 'stamps' WHERE active_loyalty_type = 'points';
