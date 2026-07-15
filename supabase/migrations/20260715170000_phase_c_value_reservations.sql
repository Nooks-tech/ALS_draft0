-- Phase C foundation: typed value accounts, immutable ledgers, quote-bound
-- reservations, and an atomic checkout-commit extension.
--
-- This migration is additive and deliberately dormant:
--   * every mutation/worker/cutover flag is installed OFF;
--   * the legacy checkout remains compatible until an explicit cutover;
--   * legacy balances and ledgers are never rewritten;
--   * known pre-cutover drift becomes a named opening classification, not an
--     invented earn/refund/redemption event;
--   * points can reserve only an exact configured product. They never have a
--     SAR/halala conversion.
--
-- Apply only after Phase B has been applied to the explicit Frankfurt project.
-- Never use the repository's stale linked Supabase project.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';
SET LOCAL idle_in_transaction_session_timeout = '90s';

-- 2026-07-15: four merchant_ids referenced by legacy loyalty/wallet rows were
-- confirmed (live Frankfurt query) to no longer exist in public.merchants —
-- pre-existing orphaned test-merchant debris (Abdullah confirmed there are 0
-- real merchants in production; only 2 active test merchants). Materialize
-- the resolvable-merchant set ONCE, in text space (never cast the legacy
-- side to uuid — a garbage value would throw before any filter applies),
-- so every backfill/classification query below can consistently exclude
-- unresolvable tenant keys instead of importing them. Temp table is
-- transaction-scoped (ON COMMIT DROP) and freezes the set against
-- concurrent merchant changes mid-migration.
CREATE TEMP TABLE phase_c_resolvable_merchants (id_text text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO phase_c_resolvable_merchants (id_text) SELECT id::text FROM public.merchants;

DO $phase_c_preflight$
DECLARE
  required_table text;
  new_table text;
  required_function text;
  required_column record;
  points_mismatch_count bigint;
  points_mismatch_delta bigint;
  cashback_mismatch_count bigint;
  cashback_mismatch_delta bigint;
  wallet_mismatch_count bigint;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'merchants', 'products', 'promo_codes', 'promo_redemptions',
    'customer_wallet_balances', 'customer_wallet_transactions',
    'loyalty_points', 'loyalty_transactions', 'loyalty_cashback_balances',
    'loyalty_milestones', 'checkout_quotes', 'checkout_quote_lines',
    'checkout_quote_adjustments', 'payment_attempts',
    'payment_attempt_components', 'wallet_topup_intents',
    'customer_orders', 'order_lines', 'order_line_options'
  ]
  LOOP
    IF pg_catalog.to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION 'Phase C preflight: missing public.%', required_table;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'Phase C preflight: expected Supabase API roles are missing';
  END IF;

  FOR required_column IN
    SELECT * FROM (VALUES
      ('customer_orders', 'id', 'text'),
      ('customer_orders', 'payment_method', 'text'),
      ('customer_orders', 'card_paid_sar', 'numeric'),
      ('customer_orders', 'wallet_paid_sar', 'numeric'),
      ('customer_orders', 'cashback_paid_sar', 'numeric'),
      ('customer_orders', 'payment_confirmed_at', 'timestamp with time zone'),
      ('customer_orders', 'total_halala', 'bigint'),
      ('customer_orders', 'currency', 'text'),
      ('customer_orders', 'collection_state', 'text'),
      ('customer_orders', 'delivery_latitude', 'numeric'),
      ('customer_orders', 'delivery_longitude', 'numeric'),
      ('customer_orders', 'delivery_zone_config_hash', 'text'),
      ('customer_orders', 'fulfillment_authorized_at', 'timestamp with time zone'),
      ('payment_attempt_components', 'reservation_id', 'uuid'),
      ('loyalty_transactions', 'points', 'numeric'),
      ('loyalty_transactions', 'amount_sar', 'numeric'),
      ('loyalty_transactions', 'loyalty_type', 'text'),
      ('loyalty_transactions', 'config_version', 'integer'),
      ('loyalty_transactions', 'expired', 'boolean'),
      ('promo_codes', 'code', 'text'),
      ('promo_codes', 'expiry_at', 'timestamp with time zone'),
      ('promo_codes', 'usage_limit', 'integer'),
      ('promo_codes', 'usage_count', 'integer'),
      ('promo_codes', 'usage_limit_per_customer', 'integer')
    ) AS expected(table_name, column_name, data_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns AS c
       WHERE c.table_schema = 'public'
         AND c.table_name = required_column.table_name
         AND c.column_name = required_column.column_name
         AND c.data_type = required_column.data_type
    ) THEN
      RAISE EXCEPTION 'Phase C preflight: expected public.%.% type %',
        required_column.table_name, required_column.column_name, required_column.data_type;
    END IF;
  END LOOP;

  -- Phase B owns canonical order-line materialization. Phase C wraps that
  -- primitive instead of creating a competing implementation.
  required_function := 'public.materialize_quote_order_lines(text,uuid)';
  IF pg_catalog.to_regprocedure(required_function) IS NULL THEN
    RAISE EXCEPTION 'Phase C preflight: missing Phase B primitive %', required_function;
  END IF;

  FOREACH new_table IN ARRAY ARRAY[
    'phase_c_runtime_controls', 'phase_c_legacy_value_classifications',
    'loyalty_program_versions', 'wallet_accounts', 'wallet_entries',
    'wallet_reservations', 'loyalty_accounts', 'loyalty_entries',
    'loyalty_value_reservations', 'loyalty_milestone_products',
    'reward_reservations', 'promo_reservations', 'checkout_commits',
    'checkout_commit_outbox', 'phase_c_deprecated_paths'
  ]
  LOOP
    IF pg_catalog.to_regclass('public.' || new_table) IS NOT NULL THEN
      RAISE EXCEPTION 'Phase C preflight: partial/drifted object public.% already exists', new_table;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns AS c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'loyalty_points'
       AND c.column_name IN ('points', 'lifetime_points')
       AND c.data_type <> 'numeric'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'loyalty_points'
       AND column_name = 'config_version' AND data_type = 'integer'
  ) THEN
    RAISE EXCEPTION 'Phase C preflight: unexpected loyalty_points numeric/config schema';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.loyalty_points
     WHERE points < 0 OR lifetime_points < 0
        OR points <> trunc(points) OR lifetime_points <> trunc(lifetime_points)
  ) THEN
    RAISE EXCEPTION 'Phase C preflight: points balances must be nonnegative whole units';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.loyalty_cashback_balances
     WHERE balance_sar < 0 OR balance_sar * 100 <> trunc(balance_sar * 100)
  ) THEN
    RAISE EXCEPTION 'Phase C preflight: cashback balances must be exact nonnegative halalas';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.customer_wallet_balances
     WHERE balance_halalas < 0
  ) THEN
    RAISE EXCEPTION 'Phase C preflight: negative legacy wallet balance';
  END IF;

  -- Every legacy tenant key imported into a UUID-owned account must resolve to
  -- the same merchant. Never silently cast or orphan a tenant identifier.
  --
  -- Known, confirmed-orphaned anomaly (2026-07-15 live Frankfurt check,
  -- corrected after an initial false-positive: a first pass using EXCEPT
  -- with a mismatched extra label column produced 4 apparent orphans; a
  -- clean single-column EXCEPT — matching this exact query shape — proved
  -- only 2 are real): these 2 merchant_ids are referenced only by
  -- loyalty_milestones (never loyalty_points/loyalty_cashback_balances) and
  -- no longer exist in merchants (deleted test merchants, no cascade).
  -- Excluding them is not deletion — their legacy rows are simply never
  -- imported into the new Phase C schema and remain untouched old-schema
  -- debris. This is pinned as an EXACT allowlist, not a blanket "skip
  -- anything unresolvable": if any OTHER/new unresolvable merchant_id
  -- appears, this still hard-aborts so a future integrity regression can't
  -- silently ride through as "known".
  IF EXISTS (
    SELECT merchant_id::text FROM public.loyalty_points
    UNION ALL
    SELECT merchant_id::text FROM public.loyalty_cashback_balances
    UNION ALL
    SELECT merchant_id::text FROM public.loyalty_milestones
    EXCEPT
    SELECT id::text FROM public.merchants
    EXCEPT
    SELECT unnest(ARRAY[
      '4f4464c6-46d1-42bb-b1f3-44357a87559e',
      'a30386e8-c8b7-4f26-95c6-aadad097bdf4'
    ])
  ) THEN
    RAISE EXCEPTION 'Phase C preflight: an unresolvable loyalty merchant outside the known 2026-07-15 orphan allowlist appeared; stop and re-audit rather than blessing it';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.loyalty_milestones AS m
     WHERE m.is_active
       AND (
         m.foodics_product_ids IS NULL
         OR pg_catalog.jsonb_typeof(m.foodics_product_ids) <> 'array'
         OR pg_catalog.jsonb_array_length(m.foodics_product_ids) = 0
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(m.foodics_product_ids) AS element(value)
            WHERE pg_catalog.jsonb_typeof(element.value) <> 'string'
               OR btrim(element.value #>> '{}') = ''
         )
       )
  ) THEN
    RAISE EXCEPTION 'Phase C preflight: active milestone has no exact product array';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.loyalty_milestones AS m
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(m.foodics_product_ids) AS product(foodics_product_id)
     WHERE m.is_active
       AND EXISTS (SELECT 1 FROM phase_c_resolvable_merchants r WHERE r.id_text = m.merchant_id::text)
       AND (
         SELECT count(*)
           FROM public.products AS p
          WHERE p.merchant_id::text = m.merchant_id::text
            AND p.foodics_product_id = product.foodics_product_id
       ) <> 1
  ) THEN
    RAISE EXCEPTION 'Phase C preflight: active milestone product is missing or tenant-ambiguous';
  END IF;

  -- Freeze the observed pre-cutover anomaly shape. This is intentionally an
  -- exact guard: if new drift appears, stop and re-audit instead of blessing it
  -- as an opening balance. cached - ledger is the signed delta convention.
  SELECT count(*)
    INTO wallet_mismatch_count
    FROM public.customer_wallet_balances AS b
   WHERE b.balance_halalas <> COALESCE((
     SELECT sum(t.amount_halalas)
       FROM public.customer_wallet_transactions AS t
      WHERE t.customer_id = b.customer_id AND t.merchant_id = b.merchant_id
   ), 0);

  IF wallet_mismatch_count <> 0 THEN
    RAISE EXCEPTION 'Phase C preflight: expected zero wallet mismatches, found %', wallet_mismatch_count;
  END IF;

  -- 2026-07-15: confirmed the +10 points / -1510 halala cashback anomaly
  -- belongs to a REAL, currently-existing merchant (8a5da9a0-...) — not the
  -- 2 genuinely orphaned merchants excluded above, which only ever appear in
  -- loyalty_milestones. The orphan-resolvability filter here is therefore a
  -- no-op against this specific anomaly; it only guards against the 2 known
  -- orphans if they ever gained a points/cashback row. Expectation stays the
  -- original frozen +10 / -1510 shape.
  WITH deltas AS (
    SELECT b.customer_id, b.merchant_id,
           b.points::bigint - COALESCE((
             SELECT sum(t.points)::bigint
               FROM public.loyalty_transactions AS t
              WHERE t.customer_id = b.customer_id
                AND t.merchant_id = b.merchant_id
                AND t.loyalty_type = 'points'
                AND t.expired = false
           ), 0) AS delta
      FROM public.loyalty_points AS b
     WHERE EXISTS (SELECT 1 FROM phase_c_resolvable_merchants r WHERE r.id_text = b.merchant_id::text)
  )
  SELECT count(*) FILTER (WHERE delta <> 0), COALESCE(sum(delta) FILTER (WHERE delta <> 0), 0)
    INTO points_mismatch_count, points_mismatch_delta
    FROM deltas;

  IF points_mismatch_count <> 1 OR points_mismatch_delta <> 10 THEN
    RAISE EXCEPTION
      'Phase C preflight: expected one points mismatch totaling +10 among resolvable merchants, found % totaling %',
      points_mismatch_count, points_mismatch_delta;
  END IF;

  WITH deltas AS (
    SELECT b.customer_id, b.merchant_id,
           (b.balance_sar * 100)::bigint - COALESCE((
             SELECT sum(round(t.amount_sar * 100)::bigint)::bigint
               FROM public.loyalty_transactions AS t
              WHERE t.customer_id = b.customer_id
                AND t.merchant_id = b.merchant_id
                AND t.loyalty_type = 'cashback'
                AND t.expired = false
                AND t.config_version IS NOT DISTINCT FROM b.config_version
           ), 0) AS delta
      FROM public.loyalty_cashback_balances AS b
     WHERE EXISTS (SELECT 1 FROM phase_c_resolvable_merchants r WHERE r.id_text = b.merchant_id::text)
  )
  SELECT count(*) FILTER (WHERE delta <> 0), COALESCE(sum(delta) FILTER (WHERE delta <> 0), 0)
    INTO cashback_mismatch_count, cashback_mismatch_delta
    FROM deltas;

  IF cashback_mismatch_count <> 1 OR cashback_mismatch_delta <> -1510 THEN
    RAISE EXCEPTION
      'Phase C preflight: expected one cashback mismatch totaling -1510 halalas among resolvable merchants, found % totaling %',
      cashback_mismatch_count, cashback_mismatch_delta;
  END IF;
END
$phase_c_preflight$;

CREATE TABLE public.phase_c_runtime_controls (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  wallet_commands_enabled boolean NOT NULL DEFAULT false,
  loyalty_commands_enabled boolean NOT NULL DEFAULT false,
  promo_commands_enabled boolean NOT NULL DEFAULT false,
  reward_reservations_enabled boolean NOT NULL DEFAULT false,
  checkout_commit_enabled boolean NOT NULL DEFAULT false,
  reservation_expiry_worker_enabled boolean NOT NULL DEFAULT false,
  foodics_type2_rewards_enabled boolean NOT NULL DEFAULT false,
  legacy_compatibility_writes_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL DEFAULT 'migration',
  CONSTRAINT phase_c_foodics_type2_dependency CHECK (
    NOT foodics_type2_rewards_enabled OR reward_reservations_enabled
  ),
  CONSTRAINT phase_c_cutover_dependency CHECK (
    NOT checkout_commit_enabled
    OR (wallet_commands_enabled AND loyalty_commands_enabled AND promo_commands_enabled)
  )
);

INSERT INTO public.phase_c_runtime_controls (singleton) VALUES (true);

CREATE TABLE public.phase_c_legacy_value_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  value_domain text NOT NULL CHECK (value_domain IN ('wallet', 'points', 'cashback_halala')),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  customer_id text NOT NULL CHECK (btrim(customer_id) <> ''),
  legacy_config_version integer,
  cached_amount bigint NOT NULL,
  ledger_amount bigint NOT NULL,
  delta_amount bigint GENERATED ALWAYS AS (cached_amount - ledger_amount) STORED,
  classification text NOT NULL CHECK (
    classification IN ('legacy_epoch_opening_balance_attested', 'legacy_epoch_opening_balance_unattributed')
  ),
  review_state text NOT NULL CHECK (review_state IN ('attested', 'requires_review')),
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT phase_c_classification_identity_unique
    UNIQUE (value_domain, merchant_id, customer_id, legacy_config_version),
  CONSTRAINT phase_c_classification_state_consistent CHECK (
    (delta_amount = 0
      AND classification = 'legacy_epoch_opening_balance_attested'
      AND review_state = 'attested')
    OR
    (delta_amount <> 0
      AND classification = 'legacy_epoch_opening_balance_unattributed'
      AND review_state = 'requires_review')
  )
);

CREATE TABLE public.loyalty_program_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  legacy_config_version integer NOT NULL CHECK (legacy_config_version >= 1),
  status text NOT NULL DEFAULT 'legacy_import' CHECK (
    status IN ('legacy_import', 'active', 'retiring', 'retired')
  ),
  reward_reservations_enabled boolean NOT NULL DEFAULT false,
  cashback_reservations_enabled boolean NOT NULL DEFAULT false,
  foodics_type2_enabled boolean NOT NULL DEFAULT false,
  config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  retired_at timestamptz,
  CONSTRAINT loyalty_program_versions_identity_unique UNIQUE (merchant_id, legacy_config_version),
  CONSTRAINT loyalty_program_versions_id_merchant_unique UNIQUE (id, merchant_id),
  CONSTRAINT loyalty_program_versions_foodics_gate CHECK (
    NOT foodics_type2_enabled OR reward_reservations_enabled
  )
);

WITH source_versions AS (
  SELECT merchant_id::uuid AS merchant_id, COALESCE(config_version, 1) AS config_version
    FROM public.loyalty_points AS lp
   WHERE EXISTS (SELECT 1 FROM phase_c_resolvable_merchants r WHERE r.id_text = lp.merchant_id::text)
  UNION
  SELECT merchant_id::uuid, COALESCE(config_version, 1)
    FROM public.loyalty_cashback_balances AS lcb
   WHERE EXISTS (SELECT 1 FROM phase_c_resolvable_merchants r WHERE r.id_text = lcb.merchant_id::text)
  UNION
  SELECT merchant_id::uuid, 1
    FROM public.loyalty_milestones AS lm
   WHERE EXISTS (SELECT 1 FROM phase_c_resolvable_merchants r WHERE r.id_text = lm.merchant_id::text)
)
INSERT INTO public.loyalty_program_versions (
  merchant_id, legacy_config_version, config_snapshot
)
SELECT merchant_id, config_version,
       pg_catalog.jsonb_build_object(
         'source', 'legacy_import',
         'legacy_config_version', config_version,
         'economic_commands_enabled', false
       )
  FROM source_versions;

CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  customer_id text NOT NULL CHECK (btrim(customer_id) <> ''),
  currency text NOT NULL DEFAULT 'SAR' CHECK (currency = 'SAR'),
  balance_halala bigint NOT NULL DEFAULT 0 CHECK (balance_halala >= 0),
  reserved_halala bigint NOT NULL DEFAULT 0 CHECK (reserved_halala >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  opened_from_classification_id uuid
    REFERENCES public.phase_c_legacy_value_classifications(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT wallet_accounts_spendable CHECK (reserved_halala <= balance_halala),
  CONSTRAINT wallet_accounts_identity_unique UNIQUE (merchant_id, customer_id, currency),
  CONSTRAINT wallet_accounts_id_identity_unique UNIQUE (id, merchant_id, customer_id)
);

CREATE TABLE public.wallet_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.wallet_accounts(id) ON DELETE RESTRICT,
  amount_halala bigint NOT NULL CHECK (amount_halala <> 0),
  entry_type text NOT NULL CHECK (
    entry_type IN ('opening_balance', 'topup', 'spend', 'refund', 'correction')
  ),
  source_type text NOT NULL CHECK (btrim(source_type) <> ''),
  source_id text NOT NULL CHECK (btrim(source_id) <> ''),
  actor_type text NOT NULL CHECK (actor_type IN ('migration', 'checkout', 'provider', 'operator')),
  actor_id text,
  reversal_of uuid REFERENCES public.wallet_entries(id) ON DELETE RESTRICT,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT wallet_entries_source_unique UNIQUE (account_id, source_type, source_id, entry_type),
  CONSTRAINT wallet_entries_reversal_not_self CHECK (reversal_of IS NULL OR reversal_of <> id)
);

-- Classify and open wallets without replaying or relabeling historical rows.
INSERT INTO public.phase_c_legacy_value_classifications (
  value_domain, merchant_id, customer_id, legacy_config_version,
  cached_amount, ledger_amount, classification, review_state, evidence
)
SELECT
  'wallet', b.merchant_id, b.customer_id::text, NULL,
  b.balance_halalas,
  COALESCE(ledger.ledger_amount, 0),
  CASE WHEN b.balance_halalas = COALESCE(ledger.ledger_amount, 0)
    THEN 'legacy_epoch_opening_balance_attested'
    ELSE 'legacy_epoch_opening_balance_unattributed' END,
  CASE WHEN b.balance_halalas = COALESCE(ledger.ledger_amount, 0)
    THEN 'attested' ELSE 'requires_review' END,
  pg_catalog.jsonb_build_object(
    'reason', CASE WHEN b.balance_halalas = COALESCE(ledger.ledger_amount, 0)
      THEN 'legacy_ledger_matches_cached_balance'
      ELSE 'legacy_epoch_opening_balance_unattributed' END,
    'ledger_row_count', COALESCE(ledger.row_count, 0),
    'ledger_ids_md5', COALESCE(ledger.ids_md5, pg_catalog.md5('')),
    'identity_md5', pg_catalog.md5(b.merchant_id::text || ':' || b.customer_id::text)
  )
FROM public.customer_wallet_balances AS b
LEFT JOIN LATERAL (
  SELECT sum(t.amount_halalas)::bigint AS ledger_amount,
         count(*)::bigint AS row_count,
         pg_catalog.md5(COALESCE(string_agg(t.id::text, ',' ORDER BY t.id::text), '')) AS ids_md5
    FROM public.customer_wallet_transactions AS t
   WHERE t.customer_id = b.customer_id AND t.merchant_id = b.merchant_id
) AS ledger ON true
WHERE EXISTS (SELECT 1 FROM phase_c_resolvable_merchants r WHERE r.id_text = b.merchant_id::text);

INSERT INTO public.wallet_accounts (
  merchant_id, customer_id, balance_halala, opened_from_classification_id
)
SELECT b.merchant_id, b.customer_id::text, b.balance_halalas, c.id
  FROM public.customer_wallet_balances AS b
  JOIN public.phase_c_legacy_value_classifications AS c
    ON c.value_domain = 'wallet'
   AND c.merchant_id = b.merchant_id
   AND c.customer_id = b.customer_id::text
   AND c.legacy_config_version IS NULL;

INSERT INTO public.wallet_entries (
  account_id, amount_halala, entry_type, source_type, source_id,
  actor_type, metadata
)
SELECT a.id, a.balance_halala, 'opening_balance', 'legacy_classification',
       a.opened_from_classification_id::text, 'migration',
       pg_catalog.jsonb_build_object(
         'classification_id', a.opened_from_classification_id,
         'reason', 'legacy_epoch_opening_balance'
       )
  FROM public.wallet_accounts AS a
 WHERE a.balance_halala <> 0;

CREATE TABLE public.wallet_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.wallet_accounts(id) ON DELETE RESTRICT,
  merchant_id uuid NOT NULL,
  customer_id text NOT NULL,
  quote_id uuid NOT NULL,
  payment_attempt_id uuid NOT NULL REFERENCES public.payment_attempts(id) ON DELETE RESTRICT,
  payment_component_id uuid NOT NULL REFERENCES public.payment_attempt_components(id) ON DELETE RESTRICT,
  amount_halala bigint NOT NULL CHECK (amount_halala > 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'consumed', 'released', 'expired')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  expires_at timestamptz NOT NULL,
  consumed_order_id text REFERENCES public.customer_orders(id) ON DELETE RESTRICT,
  consumed_at timestamptz,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT wallet_reservations_account_identity_fk
    FOREIGN KEY (account_id, merchant_id, customer_id)
    REFERENCES public.wallet_accounts(id, merchant_id, customer_id) ON DELETE RESTRICT,
  CONSTRAINT wallet_reservations_quote_merchant_fk
    FOREIGN KEY (quote_id, merchant_id)
    REFERENCES public.checkout_quotes(id, merchant_id) ON DELETE RESTRICT,
  CONSTRAINT wallet_reservations_idempotency_unique UNIQUE (merchant_id, idempotency_key),
  CONSTRAINT wallet_reservations_component_unique UNIQUE (payment_component_id),
  CONSTRAINT wallet_reservations_attempt_component_unique UNIQUE (payment_attempt_id, payment_component_id),
  CONSTRAINT wallet_reservations_terminal_shape CHECK (
    (state = 'reserved' AND consumed_order_id IS NULL AND consumed_at IS NULL AND released_at IS NULL)
    OR (state = 'consumed' AND consumed_order_id IS NOT NULL AND consumed_at IS NOT NULL AND released_at IS NULL)
    OR (state IN ('released', 'expired') AND consumed_order_id IS NULL AND consumed_at IS NULL AND released_at IS NOT NULL)
  )
);

CREATE INDEX wallet_reservations_expiry_idx
  ON public.wallet_reservations (expires_at, payment_attempt_id)
  WHERE state = 'reserved';
CREATE INDEX wallet_reservations_attempt_state_idx
  ON public.wallet_reservations (payment_attempt_id, state, id);

CREATE TABLE public.loyalty_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id text NOT NULL CHECK (btrim(customer_id) <> ''),
  program_version_id uuid NOT NULL,
  unit text NOT NULL CHECK (unit IN ('points', 'cashback_halala')),
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  lifetime_earned bigint NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  opened_from_classification_id uuid
    REFERENCES public.phase_c_legacy_value_classifications(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT loyalty_accounts_program_merchant_fk
    FOREIGN KEY (program_version_id, merchant_id)
    REFERENCES public.loyalty_program_versions(id, merchant_id) ON DELETE RESTRICT,
  CONSTRAINT loyalty_accounts_spendable CHECK (reserved <= balance),
  CONSTRAINT loyalty_accounts_identity_unique
    UNIQUE (merchant_id, customer_id, program_version_id, unit),
  CONSTRAINT loyalty_accounts_id_identity_unique
    UNIQUE (id, merchant_id, customer_id, program_version_id, unit)
);

CREATE TABLE public.loyalty_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.loyalty_accounts(id) ON DELETE RESTRICT,
  delta bigint NOT NULL CHECK (delta <> 0),
  event_type text NOT NULL CHECK (
    event_type IN ('opening_balance', 'earn', 'reward_consume', 'cashback_spend', 'refund', 'expiry', 'correction')
  ),
  source_channel text NOT NULL CHECK (
    source_channel IN ('migration', 'mobile', 'web', 'qr', 'kiosk', 'foodics', 'operator', 'reversal')
  ),
  economic_source_type text NOT NULL CHECK (btrim(economic_source_type) <> ''),
  economic_source_id text NOT NULL CHECK (btrim(economic_source_id) <> ''),
  order_id text REFERENCES public.customer_orders(id) ON DELETE RESTRICT,
  reversal_of uuid REFERENCES public.loyalty_entries(id) ON DELETE RESTRICT,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT loyalty_entries_source_unique
    UNIQUE (account_id, event_type, economic_source_type, economic_source_id),
  CONSTRAINT loyalty_entries_reversal_not_self CHECK (reversal_of IS NULL OR reversal_of <> id)
);

-- Points opening classifications. The mismatch is carried as evidence on the
-- opening event; no historical transaction is relabeled or fabricated.
INSERT INTO public.phase_c_legacy_value_classifications (
  value_domain, merchant_id, customer_id, legacy_config_version,
  cached_amount, ledger_amount, classification, review_state, evidence
)
SELECT
  'points', b.merchant_id::uuid, b.customer_id, COALESCE(b.config_version, 1),
  b.points::bigint,
  COALESCE(ledger.ledger_amount, 0),
  CASE WHEN b.points::bigint = COALESCE(ledger.ledger_amount, 0)
    THEN 'legacy_epoch_opening_balance_attested'
    ELSE 'legacy_epoch_opening_balance_unattributed' END,
  CASE WHEN b.points::bigint = COALESCE(ledger.ledger_amount, 0)
    THEN 'attested' ELSE 'requires_review' END,
  pg_catalog.jsonb_build_object(
    'reason', CASE WHEN b.points::bigint = COALESCE(ledger.ledger_amount, 0)
      THEN 'legacy_ledger_matches_cached_balance'
      ELSE 'legacy_epoch_opening_balance_unattributed' END,
    'ledger_row_count', COALESCE(ledger.row_count, 0),
    'ledger_ids_md5', COALESCE(ledger.ids_md5, pg_catalog.md5('')),
    'identity_md5', pg_catalog.md5(
      b.merchant_id::text || ':' || b.customer_id || ':' || COALESCE(b.config_version, 1)::text
    ),
    'points_are_rewards_only', true
  )
FROM public.loyalty_points AS b
LEFT JOIN LATERAL (
  SELECT sum(t.points)::bigint AS ledger_amount,
         count(*)::bigint AS row_count,
         pg_catalog.md5(COALESCE(string_agg(t.id::text, ',' ORDER BY t.id::text), '')) AS ids_md5
    FROM public.loyalty_transactions AS t
   WHERE t.customer_id = b.customer_id
     AND t.merchant_id = b.merchant_id
     AND t.loyalty_type = 'points'
     AND t.expired = false
) AS ledger ON true
WHERE EXISTS (SELECT 1 FROM phase_c_resolvable_merchants r WHERE r.id_text = b.merchant_id::text);

-- Cashback opening classifications use integer halalas only.
INSERT INTO public.phase_c_legacy_value_classifications (
  value_domain, merchant_id, customer_id, legacy_config_version,
  cached_amount, ledger_amount, classification, review_state, evidence
)
SELECT
  'cashback_halala', b.merchant_id::uuid, b.customer_id, COALESCE(b.config_version, 1),
  (b.balance_sar * 100)::bigint,
  COALESCE(ledger.ledger_amount, 0),
  CASE WHEN (b.balance_sar * 100)::bigint = COALESCE(ledger.ledger_amount, 0)
    THEN 'legacy_epoch_opening_balance_attested'
    ELSE 'legacy_epoch_opening_balance_unattributed' END,
  CASE WHEN (b.balance_sar * 100)::bigint = COALESCE(ledger.ledger_amount, 0)
    THEN 'attested' ELSE 'requires_review' END,
  pg_catalog.jsonb_build_object(
    'reason', CASE WHEN (b.balance_sar * 100)::bigint = COALESCE(ledger.ledger_amount, 0)
      THEN 'legacy_ledger_matches_cached_balance'
      ELSE 'legacy_epoch_opening_balance_unattributed' END,
    'ledger_row_count', COALESCE(ledger.row_count, 0),
    'ledger_ids_md5', COALESCE(ledger.ids_md5, pg_catalog.md5('')),
    'identity_md5', pg_catalog.md5(
      b.merchant_id::text || ':' || b.customer_id || ':' || COALESCE(b.config_version, 1)::text
    ),
    'currency', 'SAR'
  )
FROM public.loyalty_cashback_balances AS b
LEFT JOIN LATERAL (
  SELECT sum(round(t.amount_sar * 100)::bigint)::bigint AS ledger_amount,
         count(*)::bigint AS row_count,
         pg_catalog.md5(COALESCE(string_agg(t.id::text, ',' ORDER BY t.id::text), '')) AS ids_md5
    FROM public.loyalty_transactions AS t
   WHERE t.customer_id = b.customer_id
     AND t.merchant_id = b.merchant_id
     AND t.loyalty_type = 'cashback'
     AND t.expired = false
     AND t.config_version IS NOT DISTINCT FROM b.config_version
) AS ledger ON true
WHERE EXISTS (SELECT 1 FROM phase_c_resolvable_merchants r WHERE r.id_text = b.merchant_id::text);

INSERT INTO public.loyalty_accounts (
  merchant_id, customer_id, program_version_id, unit,
  balance, lifetime_earned, opened_from_classification_id
)
SELECT b.merchant_id::uuid, b.customer_id, v.id, 'points',
       b.points::bigint, b.lifetime_points::bigint, c.id
  FROM public.loyalty_points AS b
  JOIN public.loyalty_program_versions AS v
    ON v.merchant_id = b.merchant_id::uuid
   AND v.legacy_config_version = COALESCE(b.config_version, 1)
  JOIN public.phase_c_legacy_value_classifications AS c
    ON c.value_domain = 'points'
   AND c.merchant_id = b.merchant_id::uuid
   AND c.customer_id = b.customer_id
   AND c.legacy_config_version = COALESCE(b.config_version, 1);

INSERT INTO public.loyalty_accounts (
  merchant_id, customer_id, program_version_id, unit,
  balance, lifetime_earned, opened_from_classification_id
)
SELECT b.merchant_id::uuid, b.customer_id, v.id, 'cashback_halala',
       (b.balance_sar * 100)::bigint,
       0, c.id
  FROM public.loyalty_cashback_balances AS b
  JOIN public.loyalty_program_versions AS v
    ON v.merchant_id = b.merchant_id::uuid
   AND v.legacy_config_version = COALESCE(b.config_version, 1)
  JOIN public.phase_c_legacy_value_classifications AS c
    ON c.value_domain = 'cashback_halala'
   AND c.merchant_id = b.merchant_id::uuid
   AND c.customer_id = b.customer_id
   AND c.legacy_config_version = COALESCE(b.config_version, 1);

INSERT INTO public.loyalty_entries (
  account_id, delta, event_type, source_channel,
  economic_source_type, economic_source_id, metadata
)
SELECT a.id, a.balance, 'opening_balance', 'migration',
       'legacy_classification', a.opened_from_classification_id::text,
       pg_catalog.jsonb_build_object(
         'classification_id', a.opened_from_classification_id,
         'unit', a.unit,
         'reason', 'legacy_epoch_opening_balance'
       )
  FROM public.loyalty_accounts AS a
 WHERE a.balance <> 0;

CREATE TABLE public.loyalty_value_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.loyalty_accounts(id) ON DELETE RESTRICT,
  merchant_id uuid NOT NULL,
  customer_id text NOT NULL,
  program_version_id uuid NOT NULL,
  unit text NOT NULL DEFAULT 'cashback_halala' CHECK (unit = 'cashback_halala'),
  quote_id uuid NOT NULL,
  payment_attempt_id uuid NOT NULL REFERENCES public.payment_attempts(id) ON DELETE RESTRICT,
  payment_component_id uuid NOT NULL REFERENCES public.payment_attempt_components(id) ON DELETE RESTRICT,
  units_reserved bigint NOT NULL CHECK (units_reserved > 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'consumed', 'released', 'expired')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  expires_at timestamptz NOT NULL,
  consumed_order_id text REFERENCES public.customer_orders(id) ON DELETE RESTRICT,
  consumed_at timestamptz,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT loyalty_value_reservations_account_identity_fk
    FOREIGN KEY (account_id, merchant_id, customer_id, program_version_id, unit)
    REFERENCES public.loyalty_accounts(id, merchant_id, customer_id, program_version_id, unit)
    ON DELETE RESTRICT,
  CONSTRAINT loyalty_value_reservations_quote_merchant_fk
    FOREIGN KEY (quote_id, merchant_id)
    REFERENCES public.checkout_quotes(id, merchant_id) ON DELETE RESTRICT,
  CONSTRAINT loyalty_value_reservations_idempotency_unique UNIQUE (merchant_id, idempotency_key),
  CONSTRAINT loyalty_value_reservations_component_unique UNIQUE (payment_component_id),
  CONSTRAINT loyalty_value_reservations_terminal_shape CHECK (
    (state = 'reserved' AND consumed_order_id IS NULL AND consumed_at IS NULL AND released_at IS NULL)
    OR (state = 'consumed' AND consumed_order_id IS NOT NULL AND consumed_at IS NOT NULL AND released_at IS NULL)
    OR (state IN ('released', 'expired') AND consumed_order_id IS NULL AND consumed_at IS NULL AND released_at IS NOT NULL)
  )
);

CREATE INDEX loyalty_value_reservations_expiry_idx
  ON public.loyalty_value_reservations (expires_at, payment_attempt_id)
  WHERE state = 'reserved';
CREATE INDEX loyalty_value_reservations_attempt_state_idx
  ON public.loyalty_value_reservations (payment_attempt_id, state, id);

CREATE TABLE public.loyalty_milestone_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  program_version_id uuid NOT NULL,
  milestone_id uuid NOT NULL REFERENCES public.loyalty_milestones(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL,
  foodics_product_id text NOT NULL CHECK (btrim(foodics_product_id) <> ''),
  points_cost bigint NOT NULL CHECK (points_cost > 0),
  max_quantity integer NOT NULL DEFAULT 1 CHECK (max_quantity BETWEEN 1 AND 10),
  is_active boolean NOT NULL DEFAULT false,
  source_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT loyalty_milestone_products_program_merchant_fk
    FOREIGN KEY (program_version_id, merchant_id)
    REFERENCES public.loyalty_program_versions(id, merchant_id) ON DELETE RESTRICT,
  CONSTRAINT loyalty_milestone_products_product_merchant_fk
    FOREIGN KEY (product_id, merchant_id)
    REFERENCES public.products(id, merchant_id) ON DELETE RESTRICT,
  CONSTRAINT loyalty_milestone_products_identity_unique
    UNIQUE (program_version_id, milestone_id, product_id),
  CONSTRAINT loyalty_milestone_products_exact_product_unique
    UNIQUE (id, merchant_id, program_version_id, product_id)
);

-- Normalize the legacy JSON product arrays under the latest imported version.
-- Rows remain inactive until a reviewed program version is explicitly enabled.
INSERT INTO public.loyalty_milestone_products (
  merchant_id, program_version_id, milestone_id, product_id,
  foodics_product_id, points_cost, is_active, source_snapshot
)
SELECT m.merchant_id::uuid, version.id, m.id, p.id,
       configured.foodics_product_id, m.points_threshold::bigint, false,
       pg_catalog.jsonb_build_object(
         'legacy_milestone_id', m.id,
         'legacy_is_active', m.is_active,
         'normalized_at', clock_timestamp(),
         'activation_requires_review', true
       )
  FROM public.loyalty_milestones AS m
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(m.foodics_product_ids)
    AS configured(foodics_product_id)
  JOIN public.products AS p
    ON p.merchant_id::text = m.merchant_id::text
   AND p.foodics_product_id = configured.foodics_product_id
  JOIN LATERAL (
    SELECT v.id
      FROM public.loyalty_program_versions AS v
     WHERE v.merchant_id = m.merchant_id::uuid
       AND EXISTS (SELECT 1 FROM phase_c_resolvable_merchants r WHERE r.id_text = m.merchant_id::text)
     ORDER BY v.legacy_config_version DESC
     LIMIT 1
  ) AS version ON true
 WHERE m.is_active;

CREATE TABLE public.reward_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.loyalty_accounts(id) ON DELETE RESTRICT,
  merchant_id uuid NOT NULL,
  customer_id text NOT NULL,
  program_version_id uuid NOT NULL,
  unit text NOT NULL DEFAULT 'points',
  milestone_product_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  payment_attempt_id uuid NOT NULL REFERENCES public.payment_attempts(id) ON DELETE RESTRICT,
  quote_line_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  points_reserved bigint NOT NULL CHECK (points_reserved > 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'consumed', 'released', 'expired')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  expires_at timestamptz NOT NULL,
  consumed_order_id text REFERENCES public.customer_orders(id) ON DELETE RESTRICT,
  consumed_at timestamptz,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reward_reservations_account_identity_fk
    FOREIGN KEY (account_id, merchant_id, customer_id, program_version_id, unit)
    REFERENCES public.loyalty_accounts(id, merchant_id, customer_id, program_version_id, unit)
    ON DELETE RESTRICT,
  CONSTRAINT reward_reservations_points_unit CHECK (unit = 'points'),
  CONSTRAINT reward_reservations_exact_product_fk
    FOREIGN KEY (milestone_product_id, merchant_id, program_version_id, product_id)
    REFERENCES public.loyalty_milestone_products(id, merchant_id, program_version_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT reward_reservations_quote_merchant_fk
    FOREIGN KEY (quote_id, merchant_id)
    REFERENCES public.checkout_quotes(id, merchant_id) ON DELETE RESTRICT,
  CONSTRAINT reward_reservations_quote_line_fk
    FOREIGN KEY (quote_line_id, quote_id)
    REFERENCES public.checkout_quote_lines(id, quote_id) ON DELETE RESTRICT,
  CONSTRAINT reward_reservations_idempotency_unique UNIQUE (merchant_id, customer_id, idempotency_key),
  CONSTRAINT reward_reservations_quote_line_unique UNIQUE (quote_line_id),
  CONSTRAINT reward_reservations_terminal_shape CHECK (
    (state = 'reserved' AND consumed_order_id IS NULL AND consumed_at IS NULL AND released_at IS NULL)
    OR (state = 'consumed' AND consumed_order_id IS NOT NULL AND consumed_at IS NOT NULL AND released_at IS NULL)
    OR (state IN ('released', 'expired') AND consumed_order_id IS NULL AND consumed_at IS NULL AND released_at IS NOT NULL)
  )
);

CREATE INDEX reward_reservations_expiry_idx
  ON public.reward_reservations (expires_at, payment_attempt_id)
  WHERE state = 'reserved';
CREATE INDEX reward_reservations_attempt_state_idx
  ON public.reward_reservations (payment_attempt_id, state, id);

CREATE TABLE public.promo_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id uuid NOT NULL REFERENCES public.promo_codes(id) ON DELETE RESTRICT,
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  customer_id text NOT NULL CHECK (btrim(customer_id) <> ''),
  quote_id uuid NOT NULL,
  payment_attempt_id uuid NOT NULL REFERENCES public.payment_attempts(id) ON DELETE RESTRICT,
  quote_adjustment_id uuid NOT NULL REFERENCES public.checkout_quote_adjustments(id) ON DELETE RESTRICT,
  discount_halala bigint NOT NULL CHECK (discount_halala > 0),
  eligible_subtotal_halala bigint NOT NULL CHECK (eligible_subtotal_halala >= 0),
  scope text NOT NULL CHECK (scope IN ('total', 'delivery', 'order_total')),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'consumed', 'released', 'expired')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  expires_at timestamptz NOT NULL,
  consumed_order_id text REFERENCES public.customer_orders(id) ON DELETE RESTRICT,
  consumed_at timestamptz,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT promo_reservations_quote_merchant_fk
    FOREIGN KEY (quote_id, merchant_id)
    REFERENCES public.checkout_quotes(id, merchant_id) ON DELETE RESTRICT,
  CONSTRAINT promo_reservations_idempotency_unique UNIQUE (merchant_id, idempotency_key),
  CONSTRAINT promo_reservations_quote_promo_unique UNIQUE (promo_id, quote_id),
  CONSTRAINT promo_reservations_adjustment_unique UNIQUE (quote_adjustment_id),
  CONSTRAINT promo_reservations_terminal_shape CHECK (
    (state = 'reserved' AND consumed_order_id IS NULL AND consumed_at IS NULL AND released_at IS NULL)
    OR (state = 'consumed' AND consumed_order_id IS NOT NULL AND consumed_at IS NOT NULL AND released_at IS NULL)
    OR (state IN ('released', 'expired') AND consumed_order_id IS NULL AND consumed_at IS NULL AND released_at IS NOT NULL)
  )
);

CREATE INDEX promo_reservations_expiry_idx
  ON public.promo_reservations (expires_at, payment_attempt_id)
  WHERE state = 'reserved';
CREATE INDEX promo_reservations_attempt_state_idx
  ON public.promo_reservations (payment_attempt_id, state, id);

CREATE TABLE public.checkout_commits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  quote_id uuid NOT NULL,
  payment_attempt_id uuid NOT NULL REFERENCES public.payment_attempts(id) ON DELETE RESTRICT,
  order_id text NOT NULL REFERENCES public.customer_orders(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  collection_state text NOT NULL CHECK (collection_state IN ('settled', 'due_at_merchant')),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT checkout_commits_quote_merchant_fk
    FOREIGN KEY (quote_id, merchant_id)
    REFERENCES public.checkout_quotes(id, merchant_id) ON DELETE RESTRICT,
  CONSTRAINT checkout_commits_merchant_idempotency_unique UNIQUE (merchant_id, idempotency_key),
  CONSTRAINT checkout_commits_quote_unique UNIQUE (quote_id),
  CONSTRAINT checkout_commits_attempt_unique UNIQUE (payment_attempt_id),
  CONSTRAINT checkout_commits_order_unique UNIQUE (order_id)
);

CREATE TABLE public.checkout_commit_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  order_id text NOT NULL REFERENCES public.customer_orders(id) ON DELETE RESTRICT,
  event_type text NOT NULL DEFAULT 'foodics_dispatch_requested'
    CHECK (event_type = 'foodics_dispatch_requested'),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'retry', 'delivered', 'dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT checkout_commit_outbox_order_event_unique UNIQUE (order_id, event_type)
);

CREATE INDEX checkout_commit_outbox_claim_idx
  ON public.checkout_commit_outbox (available_at, id)
  WHERE state IN ('pending', 'retry');

CREATE TABLE public.phase_c_deprecated_paths (
  path_key text PRIMARY KEY,
  replacement_command text NOT NULL,
  compatibility_state text NOT NULL CHECK (
    compatibility_state IN ('compatibility_only', 'blocked_after_cutover', 'removed')
  ),
  prefix_authorizes_value boolean NOT NULL DEFAULT false CHECK (NOT prefix_authorizes_value),
  notes text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO public.phase_c_deprecated_paths (
  path_key, replacement_command, compatibility_state, notes
) VALUES
  ('wallet:* payment sentinel', 'reserve_wallet_for_attempt', 'blocked_after_cutover',
   'Display/reference prefix only; never proof of payment.'),
  ('reward:* payment sentinel', 'reserve_reward_for_attempt', 'blocked_after_cutover',
   'Display/reference prefix only; exact product reservation is required.'),
  ('cashback:* payment sentinel', 'reserve_cashback_for_attempt', 'blocked_after_cutover',
   'Display/reference prefix only; never proof of payment.'),
  ('prefix order-id reward restoration', 'Phase D exact reversal component', 'blocked_after_cutover',
   'Exact foreign keys only; LIKE order_id prefix restoration is forbidden.'),
  ('unredeem_promo', 'Phase D exact promo reversal component', 'compatibility_only',
   'Legacy compatibility until checkout cutover; new commits never call it.'),
  ('Foodics Type 1 points discount', 'reserve_reward_for_attempt', 'removed',
   'Points are rewards-only and never convert to SAR.'),
  ('Foodics Type 2 adapter reward', 'authenticated sandbox contract gate', 'blocked_after_cutover',
   'Disabled until authenticated sandbox request, callback, OTP, and readback proof exist.');

CREATE FUNCTION public.phase_c_require_control(p_control text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  controls public.phase_c_runtime_controls%ROWTYPE;
  enabled boolean;
BEGIN
  SELECT * INTO STRICT controls FROM public.phase_c_runtime_controls WHERE singleton;
  enabled := CASE p_control
    WHEN 'wallet_commands_enabled' THEN controls.wallet_commands_enabled
    WHEN 'loyalty_commands_enabled' THEN controls.loyalty_commands_enabled
    WHEN 'promo_commands_enabled' THEN controls.promo_commands_enabled
    WHEN 'reward_reservations_enabled' THEN controls.reward_reservations_enabled
    WHEN 'checkout_commit_enabled' THEN controls.checkout_commit_enabled
    WHEN 'reservation_expiry_worker_enabled' THEN controls.reservation_expiry_worker_enabled
    WHEN 'foodics_type2_rewards_enabled' THEN controls.foodics_type2_rewards_enabled
    ELSE NULL
  END;
  IF enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PHASE_C_CONTROL_DISABLED:%', p_control USING ERRCODE = '55000';
  END IF;
END
$function$;

CREATE FUNCTION public.phase_c_reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Phase C immutable row: %.% may not be %d',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION public.phase_c_enforce_account_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Phase C accounts are durable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['balance_halala', 'reserved_halala', 'balance', 'reserved', 'lifetime_earned', 'version', 'updated_at'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['balance_halala', 'reserved_halala', 'balance', 'reserved', 'lifetime_earned', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'Phase C account identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Phase C account mutation requires version + 1' USING ERRCODE = '40001';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.phase_c_enforce_reservation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Phase C reservations are durable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'consumed_order_id', 'consumed_at', 'released_at', 'release_reason', 'updated_at'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state', 'consumed_order_id', 'consumed_at', 'released_at', 'release_reason', 'updated_at']) THEN
    RAISE EXCEPTION 'Phase C reservation economics/binding are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'reserved'
     OR NEW.state NOT IN ('consumed', 'released', 'expired') THEN
    RAISE EXCEPTION 'Illegal Phase C reservation transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.phase_c_enforce_outbox_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Checkout outbox rows are durable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY[
        'state', 'attempt_count', 'available_at', 'claimed_at', 'delivered_at',
        'last_error_code', 'updated_at'
      ]) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'state', 'attempt_count', 'available_at', 'claimed_at', 'delivered_at',
        'last_error_code', 'updated_at'
      ]) THEN
    RAISE EXCEPTION 'Checkout outbox identity/payload are immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.state IN ('pending', 'retry') AND NEW.state = 'processing')
    OR (OLD.state = 'processing' AND NEW.state IN ('retry', 'delivered', 'dead_letter'))
  ) THEN
    RAISE EXCEPTION 'Illegal checkout outbox transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE TRIGGER phase_c_wallet_accounts_guard
  BEFORE UPDATE OR DELETE ON public.wallet_accounts
  FOR EACH ROW EXECUTE FUNCTION public.phase_c_enforce_account_mutation();
CREATE TRIGGER phase_c_loyalty_accounts_guard
  BEFORE UPDATE OR DELETE ON public.loyalty_accounts
  FOR EACH ROW EXECUTE FUNCTION public.phase_c_enforce_account_mutation();

CREATE TRIGGER phase_c_wallet_entries_immutable
  BEFORE UPDATE OR DELETE ON public.wallet_entries
  FOR EACH ROW EXECUTE FUNCTION public.phase_c_reject_immutable_mutation();
CREATE TRIGGER phase_c_loyalty_entries_immutable
  BEFORE UPDATE OR DELETE ON public.loyalty_entries
  FOR EACH ROW EXECUTE FUNCTION public.phase_c_reject_immutable_mutation();
CREATE TRIGGER phase_c_classifications_immutable
  BEFORE UPDATE OR DELETE ON public.phase_c_legacy_value_classifications
  FOR EACH ROW EXECUTE FUNCTION public.phase_c_reject_immutable_mutation();
CREATE TRIGGER phase_c_milestone_products_immutable
  BEFORE UPDATE OR DELETE ON public.loyalty_milestone_products
  FOR EACH ROW EXECUTE FUNCTION public.phase_c_reject_immutable_mutation();
CREATE TRIGGER phase_c_checkout_commits_immutable
  BEFORE UPDATE OR DELETE ON public.checkout_commits
  FOR EACH ROW EXECUTE FUNCTION public.phase_c_reject_immutable_mutation();
CREATE TRIGGER phase_c_deprecated_paths_immutable
  BEFORE UPDATE OR DELETE ON public.phase_c_deprecated_paths
  FOR EACH ROW EXECUTE FUNCTION public.phase_c_reject_immutable_mutation();

CREATE TRIGGER phase_c_wallet_reservations_guard
  BEFORE UPDATE OR DELETE ON public.wallet_reservations
  FOR EACH ROW EXECUTE FUNCTION public.phase_c_enforce_reservation_mutation();
CREATE TRIGGER phase_c_loyalty_value_reservations_guard
  BEFORE UPDATE OR DELETE ON public.loyalty_value_reservations
  FOR EACH ROW EXECUTE FUNCTION public.phase_c_enforce_reservation_mutation();
CREATE TRIGGER phase_c_reward_reservations_guard
  BEFORE UPDATE OR DELETE ON public.reward_reservations
  FOR EACH ROW EXECUTE FUNCTION public.phase_c_enforce_reservation_mutation();
CREATE TRIGGER phase_c_promo_reservations_guard
  BEFORE UPDATE OR DELETE ON public.promo_reservations
  FOR EACH ROW EXECUTE FUNCTION public.phase_c_enforce_reservation_mutation();
CREATE TRIGGER phase_c_checkout_outbox_guard
  BEFORE UPDATE OR DELETE ON public.checkout_commit_outbox
  FOR EACH ROW EXECUTE FUNCTION public.phase_c_enforce_outbox_transition();

CREATE FUNCTION public.credit_wallet_from_topup_intent(p_topup_intent_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  topup public.wallet_topup_intents%ROWTYPE;
  account public.wallet_accounts%ROWTYPE;
  entry_id uuid;
BEGIN
  PERFORM public.phase_c_require_control('wallet_commands_enabled');

  SELECT * INTO topup
    FROM public.wallet_topup_intents
   WHERE id = p_topup_intent_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOPUP_INTENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT e.id INTO entry_id
    FROM public.wallet_entries AS e
    JOIN public.wallet_accounts AS a ON a.id = e.account_id
   WHERE e.source_type = 'wallet_topup_intent'
     AND e.source_id = topup.id::text
     AND e.entry_type = 'topup'
     AND a.merchant_id = topup.merchant_id
     AND a.customer_id = topup.customer_id;
  IF entry_id IS NOT NULL THEN
    IF topup.state <> 'credited' THEN
      RAISE EXCEPTION 'TOPUP_ENTRY_STATE_CONFLICT' USING ERRCODE = '23514';
    END IF;
    RETURN entry_id;
  END IF;

  IF topup.state <> 'captured' THEN
    RAISE EXCEPTION 'TOPUP_NOT_CAPTURED' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.wallet_accounts (
    merchant_id, customer_id, currency, balance_halala, reserved_halala
  ) VALUES (
    topup.merchant_id, topup.customer_id, 'SAR', 0, 0
  ) ON CONFLICT (merchant_id, customer_id, currency) DO NOTHING;

  SELECT * INTO STRICT account
    FROM public.wallet_accounts
   WHERE merchant_id = topup.merchant_id
     AND customer_id = topup.customer_id
     AND currency = 'SAR'
   FOR UPDATE;

  INSERT INTO public.wallet_entries (
    account_id, amount_halala, entry_type, source_type, source_id,
    actor_type, actor_id, metadata
  ) VALUES (
    account.id, topup.amount_halala, 'topup', 'wallet_topup_intent', topup.id::text,
    'provider', topup.provider, pg_catalog.jsonb_build_object('currency', topup.currency)
  ) RETURNING id INTO entry_id;

  UPDATE public.wallet_accounts
     SET balance_halala = balance_halala + topup.amount_halala,
         version = version + 1
   WHERE id = account.id;

  UPDATE public.wallet_topup_intents
     SET state = 'credited', version = version + 1
   WHERE id = topup.id;

  RETURN entry_id;
END
$function$;

CREATE FUNCTION public.reserve_wallet_for_attempt(
  p_payment_attempt_id uuid,
  p_payment_component_id uuid,
  p_idempotency_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  attempt public.payment_attempts%ROWTYPE;
  quote public.checkout_quotes%ROWTYPE;
  component public.payment_attempt_components%ROWTYPE;
  account public.wallet_accounts%ROWTYPE;
  existing public.wallet_reservations%ROWTYPE;
  v_reservation_id uuid;
BEGIN
  PERFORM public.phase_c_require_control('wallet_commands_enabled');
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO attempt FROM public.payment_attempts
   WHERE id = p_payment_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO quote FROM public.checkout_quotes
   WHERE id = attempt.quote_id FOR UPDATE;
  SELECT * INTO component FROM public.payment_attempt_components
   WHERE id = p_payment_component_id AND attempt_id = attempt.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_COMPONENT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO existing FROM public.wallet_reservations
   WHERE merchant_id = attempt.merchant_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.payment_attempt_id <> attempt.id
       OR existing.payment_component_id <> component.id
       OR existing.amount_halala <> component.amount_halala THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN existing.id;
  END IF;

  IF quote.id IS NULL OR quote.state <> 'attempted' OR quote.expires_at <= clock_timestamp()
     OR attempt.state NOT IN ('created', 'provider_pending')
     OR attempt.customer_id IS NULL OR attempt.customer_id IS DISTINCT FROM quote.customer_id
     OR component.tender_type <> 'wallet' OR component.collection_state <> 'pending'
     OR component.reservation_id IS NOT NULL THEN
    RAISE EXCEPTION 'WALLET_RESERVATION_BINDING_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO account FROM public.wallet_accounts
   WHERE merchant_id = attempt.merchant_id
     AND customer_id = attempt.customer_id
     AND currency = 'SAR'
   FOR UPDATE;
  IF NOT FOUND OR account.balance_halala - account.reserved_halala < component.amount_halala THEN
    RAISE EXCEPTION 'INSUFFICIENT_WALLET_BALANCE' USING ERRCODE = '22000';
  END IF;

  INSERT INTO public.wallet_reservations (
    account_id, merchant_id, customer_id, quote_id, payment_attempt_id,
    payment_component_id, amount_halala, idempotency_key, expires_at
  ) VALUES (
    account.id, attempt.merchant_id, attempt.customer_id, quote.id, attempt.id,
    component.id, component.amount_halala, p_idempotency_key,
    LEAST(quote.expires_at, attempt.expires_at)
  ) RETURNING id INTO v_reservation_id;

  UPDATE public.wallet_accounts
     SET reserved_halala = reserved_halala + component.amount_halala,
         version = version + 1
   WHERE id = account.id;
  UPDATE public.payment_attempt_components
     SET collection_state = 'reserved', reservation_id = v_reservation_id
   WHERE id = component.id;

  RETURN v_reservation_id;
END
$function$;

CREATE FUNCTION public.reserve_cashback_for_attempt(
  p_payment_attempt_id uuid,
  p_payment_component_id uuid,
  p_idempotency_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  attempt public.payment_attempts%ROWTYPE;
  quote public.checkout_quotes%ROWTYPE;
  component public.payment_attempt_components%ROWTYPE;
  account public.loyalty_accounts%ROWTYPE;
  program_row public.loyalty_program_versions%ROWTYPE;
  existing public.loyalty_value_reservations%ROWTYPE;
  v_program_version_id uuid;
  v_reservation_id uuid;
BEGIN
  PERFORM public.phase_c_require_control('loyalty_commands_enabled');
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO attempt FROM public.payment_attempts
   WHERE id = p_payment_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO quote FROM public.checkout_quotes WHERE id = attempt.quote_id FOR UPDATE;
  SELECT * INTO component FROM public.payment_attempt_components
   WHERE id = p_payment_component_id AND attempt_id = attempt.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_COMPONENT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO existing FROM public.loyalty_value_reservations
   WHERE merchant_id = attempt.merchant_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.payment_attempt_id <> attempt.id
       OR existing.payment_component_id <> component.id
       OR existing.units_reserved <> component.amount_halala THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN existing.id;
  END IF;

  IF quote.id IS NULL OR quote.state <> 'attempted' OR quote.expires_at <= clock_timestamp()
     OR attempt.state NOT IN ('created', 'provider_pending')
     OR attempt.customer_id IS NULL OR attempt.customer_id IS DISTINCT FROM quote.customer_id
     OR component.tender_type <> 'cashback' OR component.collection_state <> 'pending'
     OR component.reservation_id IS NOT NULL THEN
    RAISE EXCEPTION 'CASHBACK_RESERVATION_BINDING_INVALID' USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_program_version_id := (quote.source_snapshot->>'cashback_program_version_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'CASHBACK_PROGRAM_VERSION_REQUIRED' USING ERRCODE = '23514';
  END;
  IF v_program_version_id IS NULL THEN
    RAISE EXCEPTION 'CASHBACK_PROGRAM_VERSION_REQUIRED' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO program_row FROM public.loyalty_program_versions
   WHERE id = v_program_version_id AND merchant_id = attempt.merchant_id
   FOR SHARE;
  IF NOT FOUND OR NOT program_row.cashback_reservations_enabled OR program_row.status <> 'active' THEN
    RAISE EXCEPTION 'CASHBACK_PROGRAM_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO account FROM public.loyalty_accounts
   WHERE merchant_id = attempt.merchant_id
     AND customer_id = attempt.customer_id
     AND program_version_id = v_program_version_id
     AND unit = 'cashback_halala'
   FOR UPDATE;
  IF NOT FOUND OR account.balance - account.reserved < component.amount_halala THEN
    RAISE EXCEPTION 'INSUFFICIENT_CASHBACK_BALANCE' USING ERRCODE = '22000';
  END IF;

  INSERT INTO public.loyalty_value_reservations (
    account_id, merchant_id, customer_id, program_version_id, quote_id,
    payment_attempt_id, payment_component_id, units_reserved,
    idempotency_key, expires_at
  ) VALUES (
    account.id, attempt.merchant_id, attempt.customer_id, v_program_version_id, quote.id,
    attempt.id, component.id, component.amount_halala,
    p_idempotency_key, LEAST(quote.expires_at, attempt.expires_at)
  ) RETURNING id INTO v_reservation_id;

  UPDATE public.loyalty_accounts
     SET reserved = reserved + component.amount_halala,
         version = version + 1
   WHERE id = account.id;
  UPDATE public.payment_attempt_components
     SET collection_state = 'reserved', reservation_id = v_reservation_id
   WHERE id = component.id;

  RETURN v_reservation_id;
END
$function$;

CREATE FUNCTION public.reserve_reward_for_attempt(
  p_payment_attempt_id uuid,
  p_quote_line_id uuid,
  p_milestone_product_id uuid,
  p_quantity integer,
  p_idempotency_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  attempt public.payment_attempts%ROWTYPE;
  quote public.checkout_quotes%ROWTYPE;
  quote_line public.checkout_quote_lines%ROWTYPE;
  configured public.loyalty_milestone_products%ROWTYPE;
  account public.loyalty_accounts%ROWTYPE;
  program public.loyalty_program_versions%ROWTYPE;
  existing public.reward_reservations%ROWTYPE;
  adjustment_count integer;
  v_reservation_id uuid;
  v_points bigint;
BEGIN
  PERFORM public.phase_c_require_control('loyalty_commands_enabled');
  PERFORM public.phase_c_require_control('reward_reservations_enabled');
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 128
     OR p_quantity NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'INVALID_REWARD_RESERVATION_INPUT' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO attempt FROM public.payment_attempts
   WHERE id = p_payment_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO quote FROM public.checkout_quotes WHERE id = attempt.quote_id FOR UPDATE;
  SELECT * INTO quote_line FROM public.checkout_quote_lines
   WHERE id = p_quote_line_id AND quote_id = quote.id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'QUOTE_LINE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO configured FROM public.loyalty_milestone_products
   WHERE id = p_milestone_product_id AND merchant_id = attempt.merchant_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MILESTONE_PRODUCT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO existing FROM public.reward_reservations
   WHERE merchant_id = attempt.merchant_id
     AND customer_id = attempt.customer_id
     AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.payment_attempt_id <> attempt.id
       OR existing.quote_line_id <> quote_line.id
       OR existing.milestone_product_id <> configured.id
       OR existing.quantity <> p_quantity THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN existing.id;
  END IF;

  IF quote.id IS NULL OR quote.state <> 'attempted' OR quote.expires_at <= clock_timestamp()
     OR attempt.state NOT IN ('created', 'provider_pending', 'authorized', 'captured', 'due')
     OR attempt.customer_id IS NULL OR attempt.customer_id IS DISTINCT FROM quote.customer_id
     OR configured.product_id <> quote_line.product_id
     OR NOT configured.is_active OR p_quantity > configured.max_quantity
     OR p_quantity <> quote_line.quantity
     OR quote_line.line_discount_halala <> quote_line.line_subtotal_halala
     OR quote_line.line_total_halala <> 0 THEN
    RAISE EXCEPTION 'REWARD_EXACT_PRODUCT_BINDING_INVALID' USING ERRCODE = '23514';
  END IF;

  IF quote.source_snapshot->>'loyalty_program_version_id' IS DISTINCT FROM configured.program_version_id::text THEN
    RAISE EXCEPTION 'REWARD_PROGRAM_VERSION_MISMATCH' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO adjustment_count
    FROM public.checkout_quote_adjustments AS adjustment
   WHERE adjustment.quote_id = quote.id
     AND adjustment.kind = 'reward_discount'
     AND adjustment.source_id = configured.milestone_id::text
     AND adjustment.amount_halala = quote_line.line_discount_halala;
  IF adjustment_count <> 1 THEN
    RAISE EXCEPTION 'REWARD_ADJUSTMENT_BINDING_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO program FROM public.loyalty_program_versions
   WHERE id = configured.program_version_id AND merchant_id = configured.merchant_id FOR SHARE;
  IF NOT FOUND OR program.status <> 'active' OR NOT program.reward_reservations_enabled THEN
    RAISE EXCEPTION 'REWARD_PROGRAM_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;

  v_points := configured.points_cost * p_quantity;
  SELECT * INTO account FROM public.loyalty_accounts
   WHERE merchant_id = attempt.merchant_id
     AND customer_id = attempt.customer_id
     AND program_version_id = configured.program_version_id
     AND unit = 'points'
   FOR UPDATE;
  IF NOT FOUND OR account.balance - account.reserved < v_points THEN
    RAISE EXCEPTION 'INSUFFICIENT_REWARD_POINTS' USING ERRCODE = '22000';
  END IF;

  INSERT INTO public.reward_reservations (
    account_id, merchant_id, customer_id, program_version_id,
    milestone_product_id, product_id, quote_id, payment_attempt_id,
    quote_line_id, quantity, points_reserved, idempotency_key, expires_at
  ) VALUES (
    account.id, attempt.merchant_id, attempt.customer_id, configured.program_version_id,
    configured.id, configured.product_id, quote.id, attempt.id,
    quote_line.id, p_quantity, v_points, p_idempotency_key,
    LEAST(quote.expires_at, attempt.expires_at)
  ) RETURNING id INTO v_reservation_id;

  UPDATE public.loyalty_accounts
     SET reserved = reserved + v_points, version = version + 1
   WHERE id = account.id;

  RETURN v_reservation_id;
END
$function$;

CREATE FUNCTION public.reserve_promo_for_attempt(
  p_payment_attempt_id uuid,
  p_quote_adjustment_id uuid,
  p_idempotency_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  attempt public.payment_attempts%ROWTYPE;
  quote public.checkout_quotes%ROWTYPE;
  adjustment public.checkout_quote_adjustments%ROWTYPE;
  promo public.promo_codes%ROWTYPE;
  existing public.promo_reservations%ROWTYPE;
  legacy_consumed bigint;
  active_reserved bigint;
  customer_consumed bigint;
  customer_reserved bigint;
  quoted_promo_total bigint;
  v_reservation_id uuid;
BEGIN
  PERFORM public.phase_c_require_control('promo_commands_enabled');
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO attempt FROM public.payment_attempts
   WHERE id = p_payment_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO quote FROM public.checkout_quotes WHERE id = attempt.quote_id FOR UPDATE;
  SELECT * INTO adjustment FROM public.checkout_quote_adjustments
   WHERE id = p_quote_adjustment_id AND quote_id = quote.id FOR SHARE;
  IF NOT FOUND OR adjustment.kind <> 'promo_discount' THEN
    RAISE EXCEPTION 'PROMO_ADJUSTMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO existing FROM public.promo_reservations
   WHERE merchant_id = attempt.merchant_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.payment_attempt_id <> attempt.id
       OR existing.quote_adjustment_id <> adjustment.id
       OR existing.discount_halala <> adjustment.amount_halala THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN existing.id;
  END IF;

  SELECT COALESCE(sum(candidate.amount_halala), 0)
    INTO quoted_promo_total
    FROM public.checkout_quote_adjustments AS candidate
   WHERE candidate.quote_id = quote.id AND candidate.kind = 'promo_discount';

  IF quote.id IS NULL OR quote.state <> 'attempted' OR quote.expires_at <= clock_timestamp()
     OR attempt.state NOT IN ('created', 'provider_pending')
     OR attempt.customer_id IS NULL OR attempt.customer_id IS DISTINCT FROM quote.customer_id
     OR quote.promo_discount_halala <> quoted_promo_total THEN
    -- Guest promo quota is intentionally fail-closed. A guest-session/fingerprint
    -- is not a hard per-person identity and must not pretend to enforce a cap.
    RAISE EXCEPTION 'PROMO_RESERVATION_BINDING_INVALID_OR_GUEST' USING ERRCODE = '23514';
  END IF;

  BEGIN
    SELECT * INTO promo FROM public.promo_codes
     WHERE id = adjustment.source_id::uuid AND merchant_id = attempt.merchant_id
     FOR UPDATE;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'PROMO_SOURCE_ID_INVALID' USING ERRCODE = '23514';
  END;
  IF NOT FOUND OR (promo.expiry_at IS NOT NULL AND promo.expiry_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'PROMO_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO legacy_consumed
    FROM public.promo_redemptions WHERE promo_id = promo.id;
  SELECT count(*) INTO active_reserved
    FROM public.promo_reservations
   WHERE promo_id = promo.id AND state = 'reserved' AND expires_at > clock_timestamp();
  IF promo.usage_limit IS NOT NULL
     AND GREATEST(COALESCE(promo.usage_count, 0), legacy_consumed) + active_reserved >= promo.usage_limit THEN
    RAISE EXCEPTION 'PROMO_GLOBAL_LIMIT_REACHED' USING ERRCODE = '22000';
  END IF;

  SELECT count(*) INTO customer_consumed
    FROM public.promo_redemptions
   WHERE promo_id = promo.id AND customer_id = attempt.customer_id;
  SELECT count(*) INTO customer_reserved
    FROM public.promo_reservations
   WHERE promo_id = promo.id AND customer_id = attempt.customer_id
     AND state = 'reserved' AND expires_at > clock_timestamp();
  IF promo.usage_limit_per_customer IS NOT NULL
     AND customer_consumed + customer_reserved >= promo.usage_limit_per_customer THEN
    RAISE EXCEPTION 'PROMO_CUSTOMER_LIMIT_REACHED' USING ERRCODE = '22000';
  END IF;

  INSERT INTO public.promo_reservations (
    promo_id, merchant_id, customer_id, quote_id, payment_attempt_id,
    quote_adjustment_id, discount_halala, eligible_subtotal_halala, scope,
    idempotency_key, expires_at
  ) VALUES (
    promo.id, attempt.merchant_id, attempt.customer_id, quote.id, attempt.id,
    adjustment.id, adjustment.amount_halala,
    quote.subtotal_halala + quote.modifier_total_halala,
    COALESCE(NULLIF(adjustment.metadata->>'scope', ''), 'total'),
    p_idempotency_key, LEAST(quote.expires_at, attempt.expires_at)
  ) RETURNING id INTO v_reservation_id;

  RETURN v_reservation_id;
END
$function$;

CREATE FUNCTION public.release_attempt_reservations(
  p_payment_attempt_id uuid,
  p_reason_code text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  attempt public.payment_attempts%ROWTYPE;
  wallet_row public.wallet_reservations%ROWTYPE;
  cashback_row public.loyalty_value_reservations%ROWTYPE;
  reward_row public.reward_reservations%ROWTYPE;
  promo_row public.promo_reservations%ROWTYPE;
  released_count integer := 0;
  target_state text;
BEGIN
  PERFORM public.phase_c_require_control('checkout_commit_enabled');
  IF p_reason_code NOT IN ('attempt_failed', 'attempt_cancelled', 'attempt_expired') THEN
    RAISE EXCEPTION 'INVALID_RELEASE_REASON' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO attempt FROM public.payment_attempts
   WHERE id = p_payment_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF (p_reason_code = 'attempt_failed' AND attempt.state <> 'failed')
     OR (p_reason_code = 'attempt_cancelled' AND attempt.state <> 'cancelled')
     OR (p_reason_code = 'attempt_expired' AND attempt.state <> 'expired') THEN
    RAISE EXCEPTION 'RELEASE_REASON_DOES_NOT_MATCH_ATTEMPT_STATE' USING ERRCODE = '23514';
  END IF;
  target_state := CASE WHEN attempt.state = 'expired' THEN 'expired' ELSE 'released' END;

  FOR wallet_row IN
    SELECT * FROM public.wallet_reservations
     WHERE payment_attempt_id = attempt.id AND state = 'reserved'
     ORDER BY id FOR UPDATE
  LOOP
    UPDATE public.wallet_accounts
       SET reserved_halala = reserved_halala - wallet_row.amount_halala,
           version = version + 1
     WHERE id = wallet_row.account_id
       AND reserved_halala >= wallet_row.amount_halala;
    IF NOT FOUND THEN RAISE EXCEPTION 'WALLET_RESERVATION_CONSERVATION_FAILURE' USING ERRCODE = '23514'; END IF;
    UPDATE public.wallet_reservations
       SET state = target_state, released_at = clock_timestamp(), release_reason = p_reason_code
     WHERE id = wallet_row.id;
    UPDATE public.payment_attempt_components
       SET collection_state = 'released'
     WHERE id = wallet_row.payment_component_id AND collection_state = 'reserved';
    IF NOT FOUND THEN RAISE EXCEPTION 'WALLET_COMPONENT_RELEASE_CONFLICT' USING ERRCODE = '40001'; END IF;
    released_count := released_count + 1;
  END LOOP;

  FOR cashback_row IN
    SELECT * FROM public.loyalty_value_reservations
     WHERE payment_attempt_id = attempt.id AND state = 'reserved'
     ORDER BY id FOR UPDATE
  LOOP
    UPDATE public.loyalty_accounts
       SET reserved = reserved - cashback_row.units_reserved,
           version = version + 1
     WHERE id = cashback_row.account_id AND reserved >= cashback_row.units_reserved;
    IF NOT FOUND THEN RAISE EXCEPTION 'CASHBACK_RESERVATION_CONSERVATION_FAILURE' USING ERRCODE = '23514'; END IF;
    UPDATE public.loyalty_value_reservations
       SET state = target_state, released_at = clock_timestamp(), release_reason = p_reason_code
     WHERE id = cashback_row.id;
    UPDATE public.payment_attempt_components
       SET collection_state = 'released'
     WHERE id = cashback_row.payment_component_id AND collection_state = 'reserved';
    IF NOT FOUND THEN RAISE EXCEPTION 'CASHBACK_COMPONENT_RELEASE_CONFLICT' USING ERRCODE = '40001'; END IF;
    released_count := released_count + 1;
  END LOOP;

  FOR reward_row IN
    SELECT * FROM public.reward_reservations
     WHERE payment_attempt_id = attempt.id AND state = 'reserved'
     ORDER BY id FOR UPDATE
  LOOP
    UPDATE public.loyalty_accounts
       SET reserved = reserved - reward_row.points_reserved,
           version = version + 1
     WHERE id = reward_row.account_id AND reserved >= reward_row.points_reserved;
    IF NOT FOUND THEN RAISE EXCEPTION 'REWARD_RESERVATION_CONSERVATION_FAILURE' USING ERRCODE = '23514'; END IF;
    UPDATE public.reward_reservations
       SET state = target_state, released_at = clock_timestamp(), release_reason = p_reason_code
     WHERE id = reward_row.id;
    released_count := released_count + 1;
  END LOOP;

  FOR promo_row IN
    SELECT * FROM public.promo_reservations
     WHERE payment_attempt_id = attempt.id AND state = 'reserved'
     ORDER BY id FOR UPDATE
  LOOP
    UPDATE public.promo_reservations
       SET state = target_state, released_at = clock_timestamp(), release_reason = p_reason_code
     WHERE id = promo_row.id;
    released_count := released_count + 1;
  END LOOP;

  RETURN released_count;
END
$function$;

CREATE FUNCTION public.expire_phase_c_reservations(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_attempt_id uuid;
  released_count integer := 0;
BEGIN
  PERFORM public.phase_c_require_control('reservation_expiry_worker_enabled');
  IF p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'INVALID_EXPIRY_LIMIT' USING ERRCODE = '22023';
  END IF;

  FOR v_attempt_id IN
    SELECT candidate.payment_attempt_id
      FROM (
        SELECT payment_attempt_id, expires_at FROM public.wallet_reservations WHERE state = 'reserved'
        UNION ALL
        SELECT payment_attempt_id, expires_at FROM public.loyalty_value_reservations WHERE state = 'reserved'
        UNION ALL
        SELECT payment_attempt_id, expires_at FROM public.reward_reservations WHERE state = 'reserved'
        UNION ALL
        SELECT payment_attempt_id, expires_at FROM public.promo_reservations WHERE state = 'reserved'
      ) AS candidate
      JOIN public.payment_attempts AS pa ON pa.id = candidate.payment_attempt_id
     WHERE candidate.expires_at <= clock_timestamp() AND pa.state = 'expired'
     GROUP BY candidate.payment_attempt_id
     ORDER BY min(candidate.expires_at), candidate.payment_attempt_id
     LIMIT p_limit
  LOOP
    released_count := released_count
      + public.release_attempt_reservations(v_attempt_id, 'attempt_expired');
  END LOOP;
  RETURN released_count;
END
$function$;

CREATE FUNCTION public.commit_checkout_with_reservations(
  p_quote_id uuid,
  p_payment_attempt_id uuid,
  p_order_id text,
  p_client_idempotency_key text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  quote public.checkout_quotes%ROWTYPE;
  attempt public.payment_attempts%ROWTYPE;
  existing public.checkout_commits%ROWTYPE;
  wallet_row public.wallet_reservations%ROWTYPE;
  cashback_row public.loyalty_value_reservations%ROWTYPE;
  reward_row public.reward_reservations%ROWTYPE;
  promo_row public.promo_reservations%ROWTYPE;
  component_total bigint;
  invalid_components bigint;
  wallet_component_count bigint;
  wallet_reservation_count bigint;
  cashback_component_count bigint;
  cashback_reservation_count bigint;
  promo_reserved_total bigint;
  reward_reserved_discount bigint;
  v_collection_state text;
  now_at timestamptz := clock_timestamp();
  legacy_items jsonb;
  card_paid_halala bigint;
  wallet_paid_halala bigint;
  cashback_paid_halala bigint;
BEGIN
  PERFORM public.phase_c_require_control('checkout_commit_enabled');
  IF p_order_id IS NULL OR btrim(p_order_id) = ''
     OR p_client_idempotency_key IS NULL
     OR length(p_client_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'INVALID_COMMIT_INPUT' USING ERRCODE = '22023';
  END IF;

  -- Lock in a global order shared with release/expiry: attempt, quote, then
  -- reservations/accounts. Consume-versus-release therefore has one winner.
  SELECT * INTO attempt FROM public.payment_attempts
   WHERE id = p_payment_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO quote FROM public.checkout_quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHECKOUT_QUOTE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO existing FROM public.checkout_commits
   WHERE merchant_id = quote.merchant_id AND idempotency_key = p_client_idempotency_key;
  IF FOUND THEN
    IF existing.quote_id <> quote.id
       OR existing.payment_attempt_id <> attempt.id
       OR existing.order_id <> p_order_id
       OR existing.request_fingerprint <> quote.request_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN existing.order_id;
  END IF;

  IF attempt.quote_id <> quote.id OR attempt.merchant_id <> quote.merchant_id
     OR attempt.customer_id IS DISTINCT FROM quote.customer_id
     OR attempt.guest_session_id IS DISTINCT FROM quote.guest_session_id
     OR attempt.amount_halala <> quote.total_halala
     OR attempt.currency <> quote.currency
     OR quote.state <> 'attempted' OR quote.expires_at <= now_at
     OR attempt.state NOT IN ('captured', 'due') THEN
    RAISE EXCEPTION 'COMMIT_QUOTE_ATTEMPT_BINDING_INVALID' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM public.payment_attempt_components
   WHERE attempt_id = attempt.id
   ORDER BY component_no
   FOR UPDATE;

  SELECT COALESCE(sum(amount_halala), 0),
         count(*) FILTER (WHERE
           (tender_type IN ('card', 'apple_pay', 'saved_card') AND collection_state <> 'captured')
           OR (tender_type IN ('wallet', 'cashback') AND collection_state <> 'reserved')
           OR (tender_type = 'cash' AND collection_state <> 'due')
         ),
         count(*) FILTER (WHERE tender_type = 'wallet'),
         count(*) FILTER (WHERE tender_type = 'cashback'),
         COALESCE(sum(amount_halala) FILTER (WHERE tender_type IN ('card', 'apple_pay', 'saved_card')), 0),
         COALESCE(sum(amount_halala) FILTER (WHERE tender_type = 'wallet'), 0),
         COALESCE(sum(amount_halala) FILTER (WHERE tender_type = 'cashback'), 0)
    INTO component_total, invalid_components,
         wallet_component_count, cashback_component_count,
         card_paid_halala, wallet_paid_halala, cashback_paid_halala
    FROM public.payment_attempt_components
   WHERE attempt_id = attempt.id;

  IF component_total <> quote.total_halala OR invalid_components <> 0 THEN
    RAISE EXCEPTION 'COMMIT_COMPONENT_FUNDING_INVALID' USING ERRCODE = '23514';
  END IF;
  IF attempt.state = 'captured' AND EXISTS (
    SELECT 1 FROM public.payment_attempt_components
     WHERE attempt_id = attempt.id AND tender_type = 'cash'
  ) THEN
    RAISE EXCEPTION 'CAPTURED_ATTEMPT_MAY_NOT_CONTAIN_DUE_CASH' USING ERRCODE = '23514';
  END IF;
  IF attempt.state = 'due' AND (
    attempt.tender_type <> 'cash'
    OR EXISTS (SELECT 1 FROM public.payment_attempt_components WHERE attempt_id = attempt.id AND tender_type <> 'cash')
  ) THEN
    RAISE EXCEPTION 'DUE_ATTEMPT_MUST_BE_CASH_ONLY' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO wallet_reservation_count
    FROM public.wallet_reservations AS r
    JOIN public.payment_attempt_components AS c
      ON c.id = r.payment_component_id AND c.attempt_id = r.payment_attempt_id
   WHERE r.payment_attempt_id = attempt.id AND r.state = 'reserved'
     AND r.expires_at > now_at AND c.reservation_id = r.id
     AND c.amount_halala = r.amount_halala;
  SELECT count(*) INTO cashback_reservation_count
    FROM public.loyalty_value_reservations AS r
    JOIN public.payment_attempt_components AS c
      ON c.id = r.payment_component_id AND c.attempt_id = r.payment_attempt_id
   WHERE r.payment_attempt_id = attempt.id AND r.state = 'reserved'
     AND r.expires_at > now_at AND c.reservation_id = r.id
     AND c.amount_halala = r.units_reserved;
  IF wallet_reservation_count <> wallet_component_count
     OR cashback_reservation_count <> cashback_component_count THEN
    RAISE EXCEPTION 'COMMIT_VALUE_RESERVATION_COVERAGE_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(discount_halala), 0) INTO promo_reserved_total
    FROM public.promo_reservations
   WHERE payment_attempt_id = attempt.id AND state = 'reserved' AND expires_at > now_at;
  IF promo_reserved_total <> quote.promo_discount_halala THEN
    RAISE EXCEPTION 'COMMIT_PROMO_RESERVATION_COVERAGE_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(line.line_discount_halala), 0) INTO reward_reserved_discount
    FROM public.reward_reservations AS r
    JOIN public.checkout_quote_lines AS line ON line.id = r.quote_line_id AND line.quote_id = r.quote_id
   WHERE r.payment_attempt_id = attempt.id AND r.state = 'reserved' AND r.expires_at > now_at;
  IF reward_reserved_discount <> quote.reward_discount_halala THEN
    RAISE EXCEPTION 'COMMIT_REWARD_RESERVATION_COVERAGE_INVALID' USING ERRCODE = '23514';
  END IF;

  v_collection_state := CASE WHEN attempt.state = 'captured' THEN 'settled' ELSE 'due_at_merchant' END;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'product_id', line.product_id,
           'foodics_product_id', line.foodics_product_id,
           'name', line.product_name,
           'quantity', line.quantity,
           'line_total_halala', line.line_total_halala
         ) ORDER BY line.line_no), '[]'::jsonb)
    INTO legacy_items
    FROM public.checkout_quote_lines AS line
   WHERE line.quote_id = quote.id;

  INSERT INTO public.customer_orders (
    id, merchant_id, branch_id, customer_id, total_sar, status, items,
    order_type, payment_method, card_paid_sar, wallet_paid_sar,
    cashback_paid_sar, checkout_quote_id, payment_attempt_id,
    total_halala, currency, collection_state, payment_confirmed_at,
    fulfillment_authorized_at, delivery_latitude, delivery_longitude,
    delivery_zone_config_hash
  ) VALUES (
    p_order_id, quote.merchant_id::text, quote.branch_id::text,
    COALESCE(quote.customer_id, 'guest'), quote.total_halala::numeric / 100,
    'Preparing', legacy_items, quote.fulfillment_type, attempt.tender_type,
    card_paid_halala::numeric / 100, wallet_paid_halala::numeric / 100,
    cashback_paid_halala::numeric / 100, quote.id, attempt.id,
    quote.total_halala, quote.currency, v_collection_state,
    CASE WHEN v_collection_state = 'settled' THEN now_at ELSE NULL END,
    now_at, quote.delivery_latitude, quote.delivery_longitude,
    quote.delivery_zone_config_hash
  );

  PERFORM public.materialize_quote_order_lines(p_order_id, quote.id);

  FOR wallet_row IN
    SELECT * FROM public.wallet_reservations
     WHERE payment_attempt_id = attempt.id AND state = 'reserved'
     ORDER BY id FOR UPDATE
  LOOP
    INSERT INTO public.wallet_entries (
      account_id, amount_halala, entry_type, source_type, source_id,
      actor_type, actor_id, metadata
    ) VALUES (
      wallet_row.account_id, -wallet_row.amount_halala, 'spend',
      'wallet_reservation', wallet_row.id::text, 'checkout', p_order_id,
      pg_catalog.jsonb_build_object('attempt_id', attempt.id, 'quote_id', quote.id)
    );
    UPDATE public.wallet_accounts
       SET balance_halala = balance_halala - wallet_row.amount_halala,
           reserved_halala = reserved_halala - wallet_row.amount_halala,
           version = version + 1
     WHERE id = wallet_row.account_id
       AND balance_halala >= wallet_row.amount_halala
       AND reserved_halala >= wallet_row.amount_halala;
    IF NOT FOUND THEN RAISE EXCEPTION 'WALLET_COMMIT_CONSERVATION_FAILURE' USING ERRCODE = '23514'; END IF;
    UPDATE public.wallet_reservations
       SET state = 'consumed', consumed_order_id = p_order_id, consumed_at = now_at
     WHERE id = wallet_row.id;
    UPDATE public.payment_attempt_components SET collection_state = 'captured'
     WHERE id = wallet_row.payment_component_id AND collection_state = 'reserved';
    IF NOT FOUND THEN RAISE EXCEPTION 'WALLET_COMPONENT_CONSUME_CONFLICT' USING ERRCODE = '40001'; END IF;
  END LOOP;

  FOR cashback_row IN
    SELECT * FROM public.loyalty_value_reservations
     WHERE payment_attempt_id = attempt.id AND state = 'reserved'
     ORDER BY id FOR UPDATE
  LOOP
    INSERT INTO public.loyalty_entries (
      account_id, delta, event_type, source_channel,
      economic_source_type, economic_source_id, order_id, metadata
    ) VALUES (
      cashback_row.account_id, -cashback_row.units_reserved, 'cashback_spend', quote.channel,
      'loyalty_value_reservation', cashback_row.id::text, p_order_id,
      pg_catalog.jsonb_build_object('unit', 'cashback_halala', 'attempt_id', attempt.id)
    );
    UPDATE public.loyalty_accounts
       SET balance = balance - cashback_row.units_reserved,
           reserved = reserved - cashback_row.units_reserved,
           version = version + 1
     WHERE id = cashback_row.account_id
       AND balance >= cashback_row.units_reserved AND reserved >= cashback_row.units_reserved;
    IF NOT FOUND THEN RAISE EXCEPTION 'CASHBACK_COMMIT_CONSERVATION_FAILURE' USING ERRCODE = '23514'; END IF;
    UPDATE public.loyalty_value_reservations
       SET state = 'consumed', consumed_order_id = p_order_id, consumed_at = now_at
     WHERE id = cashback_row.id;
    UPDATE public.payment_attempt_components SET collection_state = 'captured'
     WHERE id = cashback_row.payment_component_id AND collection_state = 'reserved';
    IF NOT FOUND THEN RAISE EXCEPTION 'CASHBACK_COMPONENT_CONSUME_CONFLICT' USING ERRCODE = '40001'; END IF;
  END LOOP;

  FOR reward_row IN
    SELECT * FROM public.reward_reservations
     WHERE payment_attempt_id = attempt.id AND state = 'reserved'
     ORDER BY id FOR UPDATE
  LOOP
    INSERT INTO public.loyalty_entries (
      account_id, delta, event_type, source_channel,
      economic_source_type, economic_source_id, order_id, metadata
    ) VALUES (
      reward_row.account_id, -reward_row.points_reserved, 'reward_consume', quote.channel,
      'reward_reservation', reward_row.id::text, p_order_id,
      pg_catalog.jsonb_build_object(
        'milestone_product_id', reward_row.milestone_product_id,
        'product_id', reward_row.product_id,
        'quantity', reward_row.quantity,
        'points_are_rewards_only', true
      )
    );
    UPDATE public.loyalty_accounts
       SET balance = balance - reward_row.points_reserved,
           reserved = reserved - reward_row.points_reserved,
           version = version + 1
     WHERE id = reward_row.account_id
       AND balance >= reward_row.points_reserved AND reserved >= reward_row.points_reserved;
    IF NOT FOUND THEN RAISE EXCEPTION 'REWARD_COMMIT_CONSERVATION_FAILURE' USING ERRCODE = '23514'; END IF;
    UPDATE public.reward_reservations
       SET state = 'consumed', consumed_order_id = p_order_id, consumed_at = now_at
     WHERE id = reward_row.id;
  END LOOP;

  FOR promo_row IN
    SELECT * FROM public.promo_reservations
     WHERE payment_attempt_id = attempt.id AND state = 'reserved'
     ORDER BY id FOR UPDATE
  LOOP
    INSERT INTO public.promo_redemptions (
      merchant_id, promo_id, code, order_id, customer_id, discount_sar, scope
    )
    SELECT promo_row.merchant_id, promo_row.promo_id, promo.code, p_order_id,
           promo_row.customer_id, promo_row.discount_halala::numeric / 100, promo_row.scope
      FROM public.promo_codes AS promo
     WHERE promo.id = promo_row.promo_id;
    UPDATE public.promo_codes
       SET usage_count = COALESCE(usage_count, 0) + 1
     WHERE id = promo_row.promo_id;
    UPDATE public.promo_reservations
       SET state = 'consumed', consumed_order_id = p_order_id, consumed_at = now_at
     WHERE id = promo_row.id;
  END LOOP;

  INSERT INTO public.checkout_commits (
    merchant_id, quote_id, payment_attempt_id, order_id,
    idempotency_key, request_fingerprint, collection_state, committed_at
  ) VALUES (
    quote.merchant_id, quote.id, attempt.id, p_order_id,
    p_client_idempotency_key, quote.request_fingerprint, v_collection_state, now_at
  );

  UPDATE public.checkout_quotes
     SET state = 'committed', version = version + 1,
         committed_at = now_at, updated_at = now_at
   WHERE id = quote.id AND state = 'attempted';
  IF NOT FOUND THEN RAISE EXCEPTION 'QUOTE_COMMIT_CAS_CONFLICT' USING ERRCODE = '40001'; END IF;

  INSERT INTO public.checkout_commit_outbox (
    merchant_id, order_id, payload
  ) VALUES (
    quote.merchant_id, p_order_id,
    pg_catalog.jsonb_build_object(
      'order_id', p_order_id,
      'quote_id', quote.id,
      'payment_attempt_id', attempt.id,
      'collection_state', v_collection_state
    )
  );

  RETURN p_order_id;
END
$function$;

CREATE FUNCTION public.phase_c_value_conservation()
RETURNS TABLE (
  value_domain text,
  account_id uuid,
  balance bigint,
  ledger_balance bigint,
  reserved bigint,
  conservation_ok boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT 'wallet'::text, a.id, a.balance_halala,
         COALESCE(sum(e.amount_halala), 0)::bigint,
         a.reserved_halala,
         a.balance_halala = COALESCE(sum(e.amount_halala), 0)
           AND a.reserved_halala BETWEEN 0 AND a.balance_halala
    FROM public.wallet_accounts AS a
    LEFT JOIN public.wallet_entries AS e ON e.account_id = a.id
   GROUP BY a.id, a.balance_halala, a.reserved_halala
  UNION ALL
  SELECT a.unit, a.id, a.balance,
         COALESCE(sum(e.delta), 0)::bigint,
         a.reserved,
         a.balance = COALESCE(sum(e.delta), 0)
           AND a.reserved BETWEEN 0 AND a.balance
    FROM public.loyalty_accounts AS a
    LEFT JOIN public.loyalty_entries AS e ON e.account_id = a.id
   GROUP BY a.unit, a.id, a.balance, a.reserved
$function$;

COMMENT ON TABLE public.phase_c_legacy_value_classifications IS
  'Generic pre-cutover opening evidence. Nonzero cached-minus-ledger deltas remain requires_review and never invent a historical cause.';
COMMENT ON TABLE public.wallet_entries IS
  'Immutable signed wallet ledger in integer halalas. Service commands derive all amounts and identities from provider/checkout objects.';
COMMENT ON TABLE public.loyalty_entries IS
  'Immutable signed points/cashback ledger. Points are rewards-only and have no SAR conversion.';
COMMENT ON TABLE public.loyalty_milestone_products IS
  'Normalized exact merchant/program/product reward binding. Imported rows are inactive until separately reviewed.';
COMMENT ON TABLE public.checkout_commit_outbox IS
  'Durable dispatch intent. No worker mutation grant or enabled worker flag is installed by Phase C.';
COMMENT ON FUNCTION public.commit_checkout_with_reservations(uuid, uuid, text, text) IS
  'Phase C wrapper over Phase B order-line materialization. Locks quote/attempt, proves tender and reservation coverage, consumes value, inserts the order/outbox, and commits the quote atomically.';
COMMENT ON FUNCTION public.reserve_reward_for_attempt(uuid, uuid, uuid, integer, text) IS
  'Reserves points only for one full-discount quote line bound to an exact active configured product; never converts points to money.';

ALTER FUNCTION public.phase_c_require_control(text) OWNER TO postgres;
ALTER FUNCTION public.phase_c_reject_immutable_mutation() OWNER TO postgres;
ALTER FUNCTION public.phase_c_enforce_account_mutation() OWNER TO postgres;
ALTER FUNCTION public.phase_c_enforce_reservation_mutation() OWNER TO postgres;
ALTER FUNCTION public.phase_c_enforce_outbox_transition() OWNER TO postgres;
ALTER FUNCTION public.credit_wallet_from_topup_intent(uuid) OWNER TO postgres;
ALTER FUNCTION public.reserve_wallet_for_attempt(uuid, uuid, text) OWNER TO postgres;
ALTER FUNCTION public.reserve_cashback_for_attempt(uuid, uuid, text) OWNER TO postgres;
ALTER FUNCTION public.reserve_reward_for_attempt(uuid, uuid, uuid, integer, text) OWNER TO postgres;
ALTER FUNCTION public.reserve_promo_for_attempt(uuid, uuid, text) OWNER TO postgres;
ALTER FUNCTION public.release_attempt_reservations(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.expire_phase_c_reservations(integer) OWNER TO postgres;
ALTER FUNCTION public.commit_checkout_with_reservations(uuid, uuid, text, text) OWNER TO postgres;
ALTER FUNCTION public.phase_c_value_conservation() OWNER TO postgres;

ALTER TABLE public.phase_c_runtime_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phase_c_legacy_value_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_program_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_value_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_milestone_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkout_commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkout_commit_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phase_c_deprecated_paths ENABLE ROW LEVEL SECURITY;

-- 2026-07-15 audit fix (F21): RLS was enabled on all 15 tables above with
-- zero CREATE POLICY statements, relying on an unverified assumption that
-- this project's service_role has BYPASSRLS. It does not — this project's
-- own established convention (20260709000000_master_audit_remediation.sql:
-- "supabaseAdmin (service_role) needs an explicit policy — RLS-enabled
-- tables silently no-op service-role writes without one on this project")
-- already documents that a policy-less RLS table silently returns/affects
-- zero rows for service_role here. Without this, the entire Phase C
-- capture/reconciliation pipeline would silently no-op the moment any
-- application code (or future direct-table read) touched these tables.
DROP POLICY IF EXISTS "service_role_all" ON public.phase_c_runtime_controls;
CREATE POLICY "service_role_all" ON public.phase_c_runtime_controls
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.phase_c_legacy_value_classifications;
CREATE POLICY "service_role_all" ON public.phase_c_legacy_value_classifications
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.loyalty_program_versions;
CREATE POLICY "service_role_all" ON public.loyalty_program_versions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.wallet_accounts;
CREATE POLICY "service_role_all" ON public.wallet_accounts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.wallet_entries;
CREATE POLICY "service_role_all" ON public.wallet_entries
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.wallet_reservations;
CREATE POLICY "service_role_all" ON public.wallet_reservations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.loyalty_accounts;
CREATE POLICY "service_role_all" ON public.loyalty_accounts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.loyalty_entries;
CREATE POLICY "service_role_all" ON public.loyalty_entries
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.loyalty_value_reservations;
CREATE POLICY "service_role_all" ON public.loyalty_value_reservations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.loyalty_milestone_products;
CREATE POLICY "service_role_all" ON public.loyalty_milestone_products
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.reward_reservations;
CREATE POLICY "service_role_all" ON public.reward_reservations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.promo_reservations;
CREATE POLICY "service_role_all" ON public.promo_reservations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.checkout_commits;
CREATE POLICY "service_role_all" ON public.checkout_commits
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.checkout_commit_outbox;
CREATE POLICY "service_role_all" ON public.checkout_commit_outbox
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.phase_c_deprecated_paths;
CREATE POLICY "service_role_all" ON public.phase_c_deprecated_paths
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.phase_c_runtime_controls FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.phase_c_legacy_value_classifications FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.loyalty_program_versions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.wallet_accounts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.wallet_entries FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.wallet_reservations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.loyalty_accounts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.loyalty_entries FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.loyalty_value_reservations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.loyalty_milestone_products FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.reward_reservations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.promo_reservations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.checkout_commits FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.checkout_commit_outbox FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.phase_c_deprecated_paths FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.checkout_commit_outbox_id_seq FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.phase_c_runtime_controls TO service_role;
GRANT SELECT ON TABLE public.phase_c_legacy_value_classifications TO service_role;
GRANT SELECT ON TABLE public.loyalty_program_versions TO service_role;
GRANT SELECT ON TABLE public.wallet_accounts TO service_role;
GRANT SELECT ON TABLE public.wallet_entries TO service_role;
GRANT SELECT ON TABLE public.wallet_reservations TO service_role;
GRANT SELECT ON TABLE public.loyalty_accounts TO service_role;
GRANT SELECT ON TABLE public.loyalty_entries TO service_role;
GRANT SELECT ON TABLE public.loyalty_value_reservations TO service_role;
GRANT SELECT ON TABLE public.loyalty_milestone_products TO service_role;
GRANT SELECT ON TABLE public.reward_reservations TO service_role;
GRANT SELECT ON TABLE public.promo_reservations TO service_role;
GRANT SELECT ON TABLE public.checkout_commits TO service_role;
GRANT SELECT ON TABLE public.checkout_commit_outbox TO service_role;
GRANT SELECT ON TABLE public.phase_c_deprecated_paths TO service_role;

REVOKE ALL ON FUNCTION public.phase_c_require_control(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.phase_c_reject_immutable_mutation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.phase_c_enforce_account_mutation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.phase_c_enforce_reservation_mutation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.phase_c_enforce_outbox_transition() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.credit_wallet_from_topup_intent(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_wallet_for_attempt(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_cashback_for_attempt(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_reward_for_attempt(uuid, uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_promo_for_attempt(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_attempt_reservations(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.expire_phase_c_reservations(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commit_checkout_with_reservations(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.phase_c_value_conservation() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.credit_wallet_from_topup_intent(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_wallet_for_attempt(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_cashback_for_attempt(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_reward_for_attempt(uuid, uuid, uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_promo_for_attempt(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_attempt_reservations(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_phase_c_reservations(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_checkout_with_reservations(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.phase_c_value_conservation() TO service_role;

DO $phase_c_postconditions$
DECLARE
  untrusted_grant_count bigint;
  opening_mismatch_count bigint;
  normalized_source_count bigint;
  normalized_target_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.phase_c_runtime_controls
     WHERE wallet_commands_enabled OR loyalty_commands_enabled OR promo_commands_enabled
        OR reward_reservations_enabled OR checkout_commit_enabled
        OR reservation_expiry_worker_enabled OR foodics_type2_rewards_enabled
        OR NOT legacy_compatibility_writes_enabled
  ) THEN
    RAISE EXCEPTION 'Phase C postcondition: all new commands/workers must be off and compatibility retained';
  END IF;

  IF EXISTS (SELECT 1 FROM public.loyalty_program_versions WHERE status <> 'legacy_import'
              OR reward_reservations_enabled OR cashback_reservations_enabled OR foodics_type2_enabled)
     OR EXISTS (SELECT 1 FROM public.loyalty_milestone_products WHERE is_active) THEN
    RAISE EXCEPTION 'Phase C postcondition: imported loyalty programs/products must remain inactive';
  END IF;

  IF (SELECT count(*) FROM public.phase_c_legacy_value_classifications
       WHERE value_domain = 'points' AND review_state = 'requires_review' AND delta_amount = 10) <> 1
     OR (SELECT count(*) FROM public.phase_c_legacy_value_classifications
       WHERE value_domain = 'cashback_halala' AND review_state = 'requires_review' AND delta_amount = -1510) <> 1
     OR EXISTS (SELECT 1 FROM public.phase_c_legacy_value_classifications
       WHERE review_state = 'requires_review' AND delta_amount NOT IN (10, -1510)) THEN
    RAISE EXCEPTION 'Phase C postcondition: unexpected legacy opening classifications';
  END IF;

  SELECT count(*) INTO opening_mismatch_count
    FROM public.phase_c_value_conservation() WHERE NOT conservation_ok;
  IF opening_mismatch_count <> 0 THEN
    RAISE EXCEPTION 'Phase C postcondition: opening ledger conservation mismatch count %', opening_mismatch_count;
  END IF;

  SELECT count(*) INTO normalized_source_count
    FROM public.loyalty_milestones AS m
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(m.foodics_product_ids)
   WHERE m.is_active
     AND EXISTS (SELECT 1 FROM phase_c_resolvable_merchants r WHERE r.id_text = m.merchant_id::text);
  SELECT count(*) INTO normalized_target_count FROM public.loyalty_milestone_products;
  IF normalized_source_count <> normalized_target_count THEN
    RAISE EXCEPTION 'Phase C postcondition: milestone product normalization count mismatch % <> %',
      normalized_source_count, normalized_target_count;
  END IF;

  IF EXISTS (SELECT 1 FROM public.wallet_reservations)
     OR EXISTS (SELECT 1 FROM public.loyalty_value_reservations)
     OR EXISTS (SELECT 1 FROM public.reward_reservations)
     OR EXISTS (SELECT 1 FROM public.promo_reservations)
     OR EXISTS (SELECT 1 FROM public.checkout_commits)
     OR EXISTS (SELECT 1 FROM public.checkout_commit_outbox) THEN
    RAISE EXCEPTION 'Phase C postcondition: migration must not create runtime work';
  END IF;

  SELECT count(*) INTO untrusted_grant_count
    FROM information_schema.routine_privileges
   WHERE specific_schema = 'public'
     AND routine_name IN (
       'credit_wallet_from_topup_intent', 'reserve_wallet_for_attempt',
       'reserve_cashback_for_attempt', 'reserve_reward_for_attempt',
       'reserve_promo_for_attempt', 'release_attempt_reservations',
       'expire_phase_c_reservations', 'commit_checkout_with_reservations',
       'phase_c_value_conservation'
     )
     AND grantee IN ('PUBLIC', 'anon', 'authenticated');
  IF untrusted_grant_count <> 0 THEN
    RAISE EXCEPTION 'Phase C postcondition: untrusted function grant count %', untrusted_grant_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'phase_c_require_control', 'credit_wallet_from_topup_intent',
         'reserve_wallet_for_attempt', 'reserve_cashback_for_attempt',
         'reserve_reward_for_attempt', 'reserve_promo_for_attempt',
         'release_attempt_reservations', 'expire_phase_c_reservations',
         'commit_checkout_with_reservations', 'phase_c_value_conservation'
       )
       AND (
         NOT p.prosecdef
         OR pg_catalog.pg_get_userbyid(p.proowner) <> 'postgres'
         OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
       )
  ) THEN
    RAISE EXCEPTION 'Phase C postcondition: SECURITY DEFINER/search_path contract failed';
  END IF;
END
$phase_c_postconditions$;

COMMIT;
