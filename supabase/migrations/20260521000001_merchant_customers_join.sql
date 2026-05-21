-- Phase 6 — merchant_customers enrollment join table.
--
-- Pre-fix, "is customer C enrolled at merchant M" was inferred at the
-- application layer by checking whether a row existed in any of:
--   loyalty_member_profiles, loyalty_points, loyalty_cashback_balances,
--   customer_wallet_balances, customer_orders.
-- That's six different sources of truth, each with its own RLS rules
-- and each subject to "did the code remember to scope by merchant_id"
-- audits. The lack of a single authoritative table is what made the
-- cross-merchant leakage audit so noisy: enrollment is the
-- multi-tenant key, but there's nowhere to enforce it as a constraint.
--
-- This migration creates that single source of truth:
--   public.merchant_customers (merchant_id, customer_id) PRIMARY KEY
-- and a helper function is_customer_enrolled(merchant, customer) that
-- can be used by future RPCs and RLS policies to gate access.
--
-- It does NOT yet rewire the existing loyalty / promo / wallet code
-- to use this table — that would be a fan-out edit of dozens of call
-- sites and a behavioural-regression risk. Future work can migrate
-- those callers incrementally. For now, the table is created and
-- back-populated from the existing footprints so it's queryable.

-- ╔══════════════════════════════════════════════════════════════╗
-- ║  1. Table definition                                          ║
-- ╚══════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.merchant_customers (
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  -- customer_id stays text because the rest of the customer-data
  -- tables key on text (legacy from when auth.uid() was cast to text
  -- at insert time). Don't break compatibility.
  customer_id text NOT NULL,
  -- Audit trail: when did the relationship form, and what triggered
  -- it? "first_order" / "first_loyalty" / "back_populated" /
  -- "manual_admin". This is informational only.
  enrolled_via text NOT NULL DEFAULT 'unknown',
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  -- Optional last-interaction timestamp — lets a cron sweep
  -- inactive customer relationships if business needs that later.
  last_seen_at timestamptz,
  PRIMARY KEY (merchant_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_merchant_customers_customer
  ON public.merchant_customers (customer_id);

ALTER TABLE public.merchant_customers ENABLE ROW LEVEL SECURITY;

-- Customers can see their own enrollments (e.g. "which merchants
-- have I shopped at" — useful for future profile screens).
DROP POLICY IF EXISTS "Users can view own enrollments" ON public.merchant_customers;
CREATE POLICY "Users can view own enrollments"
  ON public.merchant_customers FOR SELECT
  USING (auth.uid()::text = customer_id);

-- No INSERT/UPDATE/DELETE policies — writes are service-role only.
-- The application layer is responsible for upserting on first
-- interaction; no end-user code should be writing to this table.

-- ╔══════════════════════════════════════════════════════════════╗
-- ║  2. Back-populate from existing customer-merchant footprints  ║
-- ╚══════════════════════════════════════════════════════════════╝
-- Pull every (merchant_id, customer_id) pair that exists in any of
-- the customer-data tables. ON CONFLICT DO NOTHING means re-running
-- this migration (or a later top-up) is safe.

INSERT INTO public.merchant_customers (merchant_id, customer_id, enrolled_via, enrolled_at)
SELECT merchant_id::uuid, customer_id, 'back_populated', MIN(created_at)
FROM (
  SELECT merchant_id, customer_id, created_at FROM public.loyalty_member_profiles
    WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL
  UNION ALL
  SELECT merchant_id, customer_id, created_at FROM public.loyalty_points
    WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL
  UNION ALL
  SELECT merchant_id, customer_id, updated_at AS created_at FROM public.loyalty_cashback_balances
    WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL
  UNION ALL
  SELECT merchant_id, customer_id, created_at FROM public.customer_orders
    WHERE merchant_id IS NOT NULL AND customer_id IS NOT NULL
) src
WHERE merchant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
GROUP BY merchant_id, customer_id
ON CONFLICT (merchant_id, customer_id) DO NOTHING;

-- ╔══════════════════════════════════════════════════════════════╗
-- ║  3. Helper functions                                          ║
-- ╚══════════════════════════════════════════════════════════════╝

-- is_customer_enrolled(merchant_id, customer_id) — fast boolean
-- check used by future RPCs that need to gate per-merchant work on
-- enrollment. SECURITY INVOKER (the default) so RLS still applies;
-- service-role callers see everything as expected.
CREATE OR REPLACE FUNCTION public.is_customer_enrolled(
  p_merchant_id uuid,
  p_customer_id text
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.merchant_customers
    WHERE merchant_id = p_merchant_id
      AND customer_id = p_customer_id
  );
$$;

-- enroll_merchant_customer(merchant_id, customer_id, via) — idempotent
-- upsert used by application code that wants to ensure a row exists
-- without overwriting the enrolled_via / enrolled_at on existing
-- relationships. Also updates last_seen_at unconditionally so a
-- future "inactive" cron has signal. SECURITY DEFINER so this can
-- safely be called via supabaseAdmin (service-role bypass is fine
-- but signalling intent here makes the contract clear).
CREATE OR REPLACE FUNCTION public.enroll_merchant_customer(
  p_merchant_id uuid,
  p_customer_id text,
  p_via text DEFAULT 'auto'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_merchant_id IS NULL OR p_customer_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.merchant_customers (merchant_id, customer_id, enrolled_via, last_seen_at)
  VALUES (p_merchant_id, p_customer_id, COALESCE(p_via, 'auto'), now())
  ON CONFLICT (merchant_id, customer_id) DO UPDATE
    SET last_seen_at = EXCLUDED.last_seen_at;
END;
$$;

REVOKE ALL ON FUNCTION public.enroll_merchant_customer(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enroll_merchant_customer(uuid, text, text) TO service_role;
