-- Phase 1 (#3): commit the increment_loyalty_points RPC to version control.
-- It was created directly in the Supabase dashboard (works in prod, atomic
-- INSERT…ON CONFLICT) but never lived in a migration, so a fresh DB rebuild
-- would lack it and earnPoints() would fail. This file mirrors the EXACT prod
-- definition (verified via pg_get_functiondef on 2026-05-30). CREATE OR REPLACE
-- is idempotent, so re-applying against prod is a no-op.
CREATE OR REPLACE FUNCTION public.increment_loyalty_points(
  p_customer_id text,
  p_merchant_id text,
  p_points integer,
  p_config_version integer DEFAULT 1
)
RETURNS TABLE(points numeric, lifetime_points numeric)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  INSERT INTO loyalty_points (customer_id, merchant_id, points, lifetime_points, config_version)
  VALUES (p_customer_id, p_merchant_id, GREATEST(p_points, 0), GREATEST(p_points, 0), p_config_version)
  ON CONFLICT (customer_id, merchant_id) DO UPDATE SET
    points = loyalty_points.points + p_points,
    lifetime_points = CASE WHEN p_points > 0 THEN loyalty_points.lifetime_points + p_points ELSE loyalty_points.lifetime_points END,
    updated_at = now()
  RETURNING loyalty_points.points, loyalty_points.lifetime_points INTO points, lifetime_points;
  RETURN NEXT;
END;
$function$;
