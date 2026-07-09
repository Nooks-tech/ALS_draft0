-- ============================================================================
-- Master-audit remediation — NEW DB OBJECTS (contract section A)
-- ============================================================================
-- Owner: ALS-MIG. Implements every object other remediation agents call by
-- name. Idempotent / re-runnable (IF NOT EXISTS / CREATE OR REPLACE). NOT yet
-- applied to any DB — this file is the version-controlled source of truth.
--
-- Root causes addressed:
--   RC-2 (LOY-1/LOY-4/LOY-10) atomic loyalty redeem  -> A1 + A4
--   LOY-5/LOY-6 atomic loyalty expire                -> A2
--   ORD-1/RC-3 foodics relay idempotency claim table -> A3
--   RC-4/VIS-1/ORD-2 relay-attention columns + index -> A5
--   VIS-8 walk-in tombstone                          -> A6
--   REG-3 cafe_slug uniqueness                       -> A7
--
-- Money/loyalty math is UNCHANGED: redeem RPCs insert the ledger row FIRST
-- (idempotency marker under a partial unique index) and only move the balance
-- if the insert was new — a duplicate call is a true no-op, mirroring
-- debit_customer_wallet in 20260708120000_phase3_money_idempotency.sql. No new
-- deduction is ever introduced.
-- ============================================================================


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  A4. Partial unique indexes on loyalty_transactions (LOY-1 / LOY-4)      ║
-- ║      Created first so the A1 RPCs can infer them for ON CONFLICT.         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Audit note: NO duplicate redeem rows exist among real data today, so a plain
-- CREATE UNIQUE INDEX is safe. The guard blocks below turn any residual dupe
-- into a clear, actionable error instead of a raw unique_violation on apply.

DO $guard$
DECLARE v_dupes integer;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT 1 FROM public.loyalty_transactions
     WHERE type = 'redeem' AND loyalty_type = 'points' AND order_id IS NOT NULL
     GROUP BY merchant_id, customer_id, order_id
    HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'idx_loyalty_tx_points_redeem_per_order: % (merchant,customer,order) key(s) already have >1 points-redeem row. Dedupe before applying.', v_dupes;
  END IF;
END $guard$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_tx_points_redeem_per_order
  ON public.loyalty_transactions (merchant_id, customer_id, order_id)
  WHERE type = 'redeem' AND loyalty_type = 'points' AND order_id IS NOT NULL;

DO $guard$
DECLARE v_dupes integer;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT 1 FROM public.loyalty_transactions
     WHERE type = 'redeem' AND loyalty_type = 'cashback' AND order_id IS NOT NULL
     GROUP BY merchant_id, customer_id, order_id
    HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'idx_loyalty_tx_cashback_redeem_per_order: % (merchant,customer,order) key(s) already have >1 cashback-redeem row. Dedupe before applying.', v_dupes;
  END IF;
END $guard$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_tx_cashback_redeem_per_order
  ON public.loyalty_transactions (merchant_id, customer_id, order_id)
  WHERE type = 'redeem' AND loyalty_type = 'cashback' AND order_id IS NOT NULL;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  A1. Atomic loyalty redeem RPCs (RC-2 / LOY-1, LOY-4, LOY-10)            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- redeem_loyalty_points(...) RETURNS jsonb
--   {status:'ok'|'duplicate'|'insufficient', new_balance:numeric}
CREATE OR REPLACE FUNCTION public.redeem_loyalty_points(
  p_customer_id   text,
  p_merchant_id   text,
  p_points        numeric,
  p_order_id      text,
  p_reference_type text,
  p_reference_id  text,
  p_source        text,
  p_description   text,
  p_program_id    uuid DEFAULT NULL,
  p_branch_id     uuid DEFAULT NULL,
  p_actor_user_id text DEFAULT NULL,
  p_actor_role    text DEFAULT NULL,
  p_metadata      jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_current numeric;
  v_new     numeric;
  v_tx_id   uuid;
BEGIN
  IF p_points IS NULL OR p_points <= 0 THEN
    RAISE EXCEPTION 'redeem points must be positive';
  END IF;

  -- Lock the balance row so the sufficiency check + decrement are consistent
  -- and concurrent redeems for this (customer, merchant) serialize.
  SELECT points INTO v_current
    FROM public.loyalty_points
    WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
    FOR UPDATE;

  -- Idempotency: a redeem already booked for this order? Return it, decrement
  -- nothing (matches idx_loyalty_tx_points_redeem_per_order).
  IF p_order_id IS NOT NULL THEN
    SELECT id INTO v_tx_id
      FROM public.loyalty_transactions
      WHERE merchant_id = p_merchant_id AND customer_id = p_customer_id
        AND order_id = p_order_id AND type = 'redeem' AND loyalty_type = 'points'
      ORDER BY created_at ASC
      LIMIT 1;
    IF v_tx_id IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'duplicate', 'new_balance', COALESCE(v_current, 0));
    END IF;
  END IF;

  -- Sufficiency BEFORE inserting the marker, so an insufficient call leaves no
  -- phantom ledger row (which would otherwise block a later legit redeem).
  IF v_current IS NULL OR v_current < p_points THEN
    RETURN jsonb_build_object('status', 'insufficient', 'new_balance', COALESCE(v_current, 0));
  END IF;

  v_new := v_current - p_points;

  -- Insert the redeem row FIRST (idempotency marker); only move the balance if
  -- the insert was new. A duplicate/race is a true no-op.
  INSERT INTO public.loyalty_transactions
    (customer_id, merchant_id, order_id, type, loyalty_type, points,
     reference_type, reference_id, source, description, program_id,
     branch_id, actor_user_id, actor_role, metadata)
  VALUES
    (p_customer_id, p_merchant_id, p_order_id, 'redeem', 'points', -p_points,
     p_reference_type, p_reference_id, COALESCE(p_source, 'app'), p_description, p_program_id,
     p_branch_id, p_actor_user_id, p_actor_role, p_metadata)
  ON CONFLICT (merchant_id, customer_id, order_id)
    WHERE type = 'redeem' AND loyalty_type = 'points' AND order_id IS NOT NULL
    DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    -- lost a concurrent race for this order: re-read balance, decrement nothing
    SELECT points INTO v_current
      FROM public.loyalty_points
      WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id;
    RETURN jsonb_build_object('status', 'duplicate', 'new_balance', COALESCE(v_current, 0));
  END IF;

  UPDATE public.loyalty_points
    SET points = v_new, updated_at = now()
    WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id;

  RETURN jsonb_build_object('status', 'ok', 'new_balance', v_new);
END
$function$;


-- redeem_loyalty_cashback(...) RETURNS jsonb
--   {status:'ok'|'duplicate'|'insufficient', new_balance_sar:numeric}
CREATE OR REPLACE FUNCTION public.redeem_loyalty_cashback(
  p_customer_id   text,
  p_merchant_id   text,
  p_amount_sar    numeric,
  p_order_id      text,
  p_reference_type text,
  p_reference_id  text,
  p_source        text,
  p_description   text,
  p_config_version int DEFAULT NULL,
  p_branch_id     uuid DEFAULT NULL,
  p_actor_user_id text DEFAULT NULL,
  p_actor_role    text DEFAULT NULL,
  p_metadata      jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_balance        numeric;
  v_new            numeric;
  v_config_version integer;
  v_tx_id          uuid;
BEGIN
  IF p_amount_sar IS NULL OR p_amount_sar <= 0 THEN
    RAISE EXCEPTION 'redeem cashback amount must be positive';
  END IF;

  -- Resolve + lock the active cashback balance row. The app treats the highest
  -- config_version as the live balance (loyaltyExpiration.ts, redeem-cashback
  -- route); honour an explicit p_config_version when the caller passes one.
  IF p_config_version IS NULL THEN
    SELECT balance_sar, config_version INTO v_balance, v_config_version
      FROM public.loyalty_cashback_balances
      WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
      ORDER BY config_version DESC
      LIMIT 1
      FOR UPDATE;
  ELSE
    SELECT balance_sar, config_version INTO v_balance, v_config_version
      FROM public.loyalty_cashback_balances
      WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
        AND config_version = p_config_version
      FOR UPDATE;
  END IF;

  -- Idempotency: a cashback redeem already booked for this order?
  IF p_order_id IS NOT NULL THEN
    SELECT id INTO v_tx_id
      FROM public.loyalty_transactions
      WHERE merchant_id = p_merchant_id AND customer_id = p_customer_id
        AND order_id = p_order_id AND type = 'redeem' AND loyalty_type = 'cashback'
      ORDER BY created_at ASC
      LIMIT 1;
    IF v_tx_id IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'duplicate', 'new_balance_sar', COALESCE(v_balance, 0));
    END IF;
  END IF;

  IF v_balance IS NULL OR v_balance < p_amount_sar THEN
    RETURN jsonb_build_object('status', 'insufficient', 'new_balance_sar', COALESCE(v_balance, 0));
  END IF;

  v_new := round(v_balance - p_amount_sar, 2);

  INSERT INTO public.loyalty_transactions
    (customer_id, merchant_id, order_id, type, loyalty_type, points, amount_sar,
     reference_type, reference_id, source, description, config_version,
     branch_id, actor_user_id, actor_role, metadata)
  VALUES
    (p_customer_id, p_merchant_id, p_order_id, 'redeem', 'cashback', 0, -p_amount_sar,
     p_reference_type, p_reference_id, COALESCE(p_source, 'app'), p_description, v_config_version,
     p_branch_id, p_actor_user_id, p_actor_role, p_metadata)
  ON CONFLICT (merchant_id, customer_id, order_id)
    WHERE type = 'redeem' AND loyalty_type = 'cashback' AND order_id IS NOT NULL
    DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    -- lost a concurrent race for this order: re-read balance, decrement nothing
    SELECT balance_sar INTO v_balance
      FROM public.loyalty_cashback_balances
      WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
        AND config_version = v_config_version;
    RETURN jsonb_build_object('status', 'duplicate', 'new_balance_sar', COALESCE(v_balance, 0));
  END IF;

  UPDATE public.loyalty_cashback_balances
    SET balance_sar = v_new, updated_at = now()
    WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
      AND config_version = v_config_version;

  RETURN jsonb_build_object('status', 'ok', 'new_balance_sar', v_new);
END
$function$;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  A2. Atomic loyalty expire RPCs (LOY-5, LOY-6)                           ║
-- ║      Caller (ALS-EXPIRY) computes the correct FIFO-lot expirable amount;  ║
-- ║      these just apply the GREATEST(0, ...) decrement atomically.          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- expire_loyalty_points(...) RETURNS numeric (new balance)
CREATE OR REPLACE FUNCTION public.expire_loyalty_points(
  p_customer_id text,
  p_merchant_id text,
  p_amount      numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_new numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    SELECT COALESCE(points, 0) INTO v_new
      FROM public.loyalty_points
      WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id;
    RETURN COALESCE(v_new, 0);
  END IF;

  UPDATE public.loyalty_points
    SET points = GREATEST(0, points - p_amount), updated_at = now()
    WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
    RETURNING points INTO v_new;

  RETURN COALESCE(v_new, 0);
END
$function$;

-- expire_loyalty_cashback(...) RETURNS numeric (new balance)
CREATE OR REPLACE FUNCTION public.expire_loyalty_cashback(
  p_customer_id text,
  p_merchant_id text,
  p_amount_sar  numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_config_version integer;
  v_new            numeric;
BEGIN
  -- Target the active (highest config_version) balance row, matching the
  -- existing expiration cron (server/cron/loyaltyExpiration.ts).
  SELECT config_version INTO v_config_version
    FROM public.loyalty_cashback_balances
    WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
    ORDER BY config_version DESC
    LIMIT 1;

  IF v_config_version IS NULL THEN
    RETURN 0;
  END IF;

  IF p_amount_sar IS NULL OR p_amount_sar <= 0 THEN
    SELECT COALESCE(balance_sar, 0) INTO v_new
      FROM public.loyalty_cashback_balances
      WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
        AND config_version = v_config_version;
    RETURN COALESCE(v_new, 0);
  END IF;

  UPDATE public.loyalty_cashback_balances
    SET balance_sar = round(GREATEST(0, balance_sar - p_amount_sar), 2), updated_at = now()
    WHERE customer_id = p_customer_id AND merchant_id = p_merchant_id
      AND config_version = v_config_version
    RETURNING balance_sar INTO v_new;

  RETURN COALESCE(v_new, 0);
END
$function$;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  A3. Foodics relay idempotency claim table (ORD-1 / RC-3)               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Insert-first claim (ON CONFLICT DO NOTHING) before calling Foodics: only the
-- insert winner proceeds, so a double-fired relay creates one Foodics order.

CREATE TABLE IF NOT EXISTS public.foodics_order_relays (
  merchant_id       text NOT NULL,
  internal_order_id text NOT NULL,
  foodics_order_id  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, internal_order_id)
);

ALTER TABLE public.foodics_order_relays ENABLE ROW LEVEL SECURITY;

-- supabaseAdmin (service_role) needs an explicit policy — RLS-enabled tables
-- silently no-op service-role writes without one on this project.
DROP POLICY IF EXISTS "service_role_all" ON public.foodics_order_relays;
CREATE POLICY "service_role_all" ON public.foodics_order_relays
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.foodics_order_relays FROM public, anon, authenticated;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  A5. customer_orders relay-attention columns + index (RC-4/VIS-1/ORD-2)  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.customer_orders
  ADD COLUMN IF NOT EXISTS foodics_relay_status          text,   -- null | 'pending' | 'failed' | 'ok'
  ADD COLUMN IF NOT EXISTS foodics_relay_error           text,
  ADD COLUMN IF NOT EXISTS foodics_relay_attempts        int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS foodics_relay_last_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_customer_orders_needs_attention
  ON public.customer_orders (merchant_id, created_at DESC)
  WHERE payment_confirmed_at IS NOT NULL AND foodics_order_id IS NULL AND status <> 'Cancelled';


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  A6. Walk-in tombstone instead of DELETE (VIS-8)                        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE public.customer_orders
  ADD COLUMN IF NOT EXISTS walkin_expired_at timestamptz;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  A7. cafe_slug uniqueness (REG-3)                                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- SQL twin of slugifyBrandName() in nooksweb/lib/brand-identifiers.ts:
-- lower + NFKD-decompose + strip everything that is not [a-z0-9]; fall back to
-- 'merchant'. NFKD decomposes accented latin (é -> e + combining mark) so the
-- base letter survives the [^a-z0-9] strip. Non-latin scripts strip to '' ->
-- 'merchant', exactly like the JS. IMMUTABLE so it can index/backfill.
CREATE OR REPLACE FUNCTION public.slugify_brand_name(p_input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT COALESCE(
    NULLIF(
      regexp_replace(lower(normalize(COALESCE(p_input, ''), NFKD)), '[^a-z0-9]', '', 'g'),
      ''
    ),
    'merchant'
  );
$function$;

ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS cafe_slug text;

-- Collision-safe backfill (only fills NULLs, so re-runs are no-ops). The first
-- merchant with a given base slug keeps it; subsequent same-base collisions get
-- base1, base2 ... (mirrors resolveBrandIdentifiers' counter). Today's 2 live
-- merchants (mofosos, burger) have distinct bases and do not collide.
-- Note: dedupe is per base-slug; a rare cross-base collision (base 'foo' #2
-- -> 'foo1' vs a distinct merchant whose base is literally 'foo1') is not
-- resolved here and would surface loudly at the unique index below — none exist
-- in the current dataset.
WITH ranked AS (
  SELECT id,
         public.slugify_brand_name(cafe_name) AS base,
         row_number() OVER (
           PARTITION BY public.slugify_brand_name(cafe_name)
           ORDER BY created_at NULLS LAST, id
         ) AS rn
  FROM public.merchants
  WHERE cafe_slug IS NULL
)
UPDATE public.merchants m
   SET cafe_slug = CASE WHEN r.rn = 1 THEN r.base ELSE r.base || (r.rn - 1)::text END
  FROM ranked r
 WHERE m.id = r.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_merchants_cafe_slug
  ON public.merchants (cafe_slug)
  WHERE cafe_slug IS NOT NULL;

-- Signup trigger: also set cafe_slug. Reproduces the exact existing body of
-- public.handle_new_user_create_merchant (canonical file lives in
-- nooksweb/supabase/migrations/20260217100003_trigger_create_merchant_on_signup.sql)
-- and adds a collision-safe slug so uq_merchants_cafe_slug can NEVER abort a
-- signup. CREATE OR REPLACE keeps the existing on_auth_user_created_create_merchant
-- trigger binding (no trigger recreate needed). Keeps SECURITY DEFINER +
-- search_path='' — hence every reference is schema-qualified.
CREATE OR REPLACE FUNCTION public.handle_new_user_create_merchant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_base    text;
  v_slug    text;
  v_counter int := 1;
BEGIN
  v_base := public.slugify_brand_name(COALESCE(new.raw_user_meta_data->>'cafe_name', ''));
  v_slug := v_base;
  -- base, base1, base2 ... until free
  WHILE EXISTS (SELECT 1 FROM public.merchants WHERE cafe_slug = v_slug) LOOP
    v_slug := v_base || v_counter::text;
    v_counter := v_counter + 1;
  END LOOP;

  BEGIN
    INSERT INTO public.merchants (user_id, full_name, cafe_name, cafe_slug, status)
    VALUES (
      new.id,
      COALESCE(new.raw_user_meta_data->>'full_name', ''),
      COALESCE(new.raw_user_meta_data->>'cafe_name', ''),
      v_slug,
      'pending'
    );
  EXCEPTION WHEN unique_violation THEN
    -- Extremely rare concurrent-signup slug race: fall back to an id-suffixed
    -- slug that cannot collide, so a signup never fails on cafe_slug. (A genuine
    -- duplicate user_id still raises on the retry, exactly as before.)
    INSERT INTO public.merchants (user_id, full_name, cafe_name, cafe_slug, status)
    VALUES (
      new.id,
      COALESCE(new.raw_user_meta_data->>'full_name', ''),
      COALESCE(new.raw_user_meta_data->>'cafe_name', ''),
      v_base || substr(replace(new.id::text, '-', ''), 1, 8),
      'pending'
    );
  END;

  RETURN new;
END
$function$;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Grants — server (service_role via supabaseAdmin) is the only caller.    ║
-- ║  Mirrors enroll_merchant_customer (20260521000001): revoke PUBLIC, grant  ║
-- ║  service_role. SECURITY DEFINER + explicit EXECUTE for service_role.      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

REVOKE ALL ON FUNCTION public.redeem_loyalty_points(text, text, numeric, text, text, text, text, text, uuid, uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_loyalty_points(text, text, numeric, text, text, text, text, text, uuid, uuid, text, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.redeem_loyalty_cashback(text, text, numeric, text, text, text, text, text, int, uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_loyalty_cashback(text, text, numeric, text, text, text, text, text, int, uuid, text, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.expire_loyalty_points(text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_loyalty_points(text, text, numeric) TO service_role;

REVOKE ALL ON FUNCTION public.expire_loyalty_cashback(text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_loyalty_cashback(text, text, numeric) TO service_role;

REVOKE ALL ON FUNCTION public.slugify_brand_name(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.slugify_brand_name(text) TO service_role;


-- ============================================================================
-- ROLLBACK (reverse order):
--   DROP FUNCTION IF EXISTS public.expire_loyalty_cashback(text, text, numeric);
--   DROP FUNCTION IF EXISTS public.expire_loyalty_points(text, text, numeric);
--   DROP FUNCTION IF EXISTS public.redeem_loyalty_cashback(text, text, numeric, text, text, text, text, text, int, uuid, text, text, jsonb);
--   DROP FUNCTION IF EXISTS public.redeem_loyalty_points(text, text, numeric, text, text, text, text, text, uuid, uuid, text, text, jsonb);
--   DROP INDEX IF EXISTS public.idx_loyalty_tx_cashback_redeem_per_order;
--   DROP INDEX IF EXISTS public.idx_loyalty_tx_points_redeem_per_order;
--   DROP TABLE IF EXISTS public.foodics_order_relays;
--   ALTER TABLE public.customer_orders
--     DROP COLUMN IF EXISTS foodics_relay_status,
--     DROP COLUMN IF EXISTS foodics_relay_error,
--     DROP COLUMN IF EXISTS foodics_relay_attempts,
--     DROP COLUMN IF EXISTS foodics_relay_last_attempt_at,
--     DROP COLUMN IF EXISTS walkin_expired_at;
--   DROP INDEX IF EXISTS public.idx_customer_orders_needs_attention;
--   DROP INDEX IF EXISTS public.uq_merchants_cafe_slug;
--   ALTER TABLE public.merchants DROP COLUMN IF EXISTS cafe_slug;
--   -- restore handle_new_user_create_merchant from nooksweb 20260217100003;
--   DROP FUNCTION IF EXISTS public.slugify_brand_name(text);
-- ============================================================================
