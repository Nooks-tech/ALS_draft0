-- Phase B foundation: immutable checkout quotes, durable payment attempts,
-- normalized order economics, and wallet top-up intents.
--
-- IMPORTANT:
--   * This is the single migration source for the shared Frankfurt database.
--     Do not mirror it into nooksweb.
--   * It is additive. Existing order and payment routes are not cut over by
--     this migration.
--   * All economic writes are service-role-only and quote persistence is one
--     atomic SECURITY DEFINER RPC.
--   * Production application remains approval-gated and must target the
--     Frankfurt project explicitly. Never use the repository's stale link.

BEGIN;

DO $phase_b_preflight$
DECLARE
  required_table text;
  required_column record;
  new_table text;
  linked_column text;
BEGIN
  -- Forward/rollback lifecycle operations share this transaction-scoped lock.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('phase_b_quote_foundation_schema_v1', 0)
  );

  FOREACH required_table IN ARRAY ARRAY[
    'merchants',
    'branch_mappings',
    'products',
    'merchant_qr_codes',
    'promo_codes',
    'customer_orders'
  ]
  LOOP
    IF pg_catalog.to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION 'Phase B preflight: missing required table public.%', required_table;
    END IF;
  END LOOP;

  FOR required_column IN
    SELECT *
      FROM (VALUES
        ('merchants', 'id', 'uuid'),
        ('branch_mappings', 'id', 'uuid'),
        ('branch_mappings', 'merchant_id', 'uuid'),
        ('branch_mappings', 'foodics_branch_id', 'text'),
        ('branch_mappings', 'updated_at', 'timestamp with time zone'),
        ('products', 'id', 'uuid'),
        ('products', 'merchant_id', 'uuid'),
        ('products', 'foodics_product_id', 'text'),
        ('products', 'updated_at', 'timestamp with time zone'),
        ('merchant_qr_codes', 'id', 'uuid'),
        ('merchant_qr_codes', 'merchant_id', 'uuid'),
        ('merchant_qr_codes', 'branch_id', 'uuid'),
        ('promo_codes', 'id', 'uuid'),
        ('promo_codes', 'merchant_id', 'uuid'),
        ('promo_codes', 'created_at', 'timestamp with time zone'),
        ('customer_orders', 'id', 'text'),
        -- Live customer_orders keeps merchant/branch identifiers as text for
        -- mobile compatibility; quote/attempt tables use UUID FKs internally.
        ('customer_orders', 'merchant_id', 'text'),
        ('customer_orders', 'customer_id', 'text'),
        ('customer_orders', 'branch_id', 'text'),
        ('customer_orders', 'order_type', 'text'),
        ('customer_orders', 'total_sar', 'numeric'),
        ('customer_orders', 'payment_confirmed_at', 'timestamp with time zone')
      ) AS inventory(table_name, column_name, expected_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.columns AS c
       WHERE c.table_schema = 'public'
         AND c.table_name = required_column.table_name
         AND c.column_name = required_column.column_name
         -- data_type intentionally ignores harmless numeric precision such as
         -- live customer_orders.total_sar numeric(10,2).
         AND c.data_type = required_column.expected_type
    ) THEN
      RAISE EXCEPTION
        'Phase B preflight: expected public.%.% type %',
        required_column.table_name,
        required_column.column_name,
        required_column.expected_type;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'promo_codes'
       AND column_name = 'updated_at'
  ) THEN
    RAISE EXCEPTION 'Phase B preflight: promo_codes.updated_at already exists';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'Phase B preflight: expected Supabase API roles are missing';
  END IF;

  FOREACH new_table IN ARRAY ARRAY[
    'checkout_quotes',
    'checkout_quote_lines',
    'checkout_quote_options',
    'checkout_quote_adjustments',
    'payment_attempts',
    'payment_attempt_components',
    'payment_attempt_observations',
    'wallet_topup_intents',
    'provider_object_bindings',
    'order_lines',
    'order_line_options'
  ]
  LOOP
    IF pg_catalog.to_regclass('public.' || new_table) IS NOT NULL THEN
      RAISE EXCEPTION 'Phase B preflight: partial/drifted object public.% already exists', new_table;
    END IF;
  END LOOP;

  FOREACH linked_column IN ARRAY ARRAY[
    'checkout_quote_id',
    'payment_attempt_id',
    'total_halala',
    'currency',
    'collection_state',
    'delivery_latitude',
    'delivery_longitude',
    'delivery_zone_config_hash',
    'fulfillment_authorized_at'
  ]
  LOOP
    IF EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'customer_orders'
         AND column_name = linked_column
    ) THEN
      RAISE EXCEPTION 'Phase B preflight: customer_orders.% already exists', linked_column;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('public.persist_checkout_quote(jsonb,jsonb,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'Phase B preflight: persist_checkout_quote overload already exists';
  END IF;
  IF pg_catalog.to_regprocedure('public.create_payment_attempt(jsonb,jsonb)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.materialize_quote_order_lines(text,uuid)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.touch_promo_codes_updated_at()') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.bind_phase_b_provider_object(text,text,text,text,uuid)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.enforce_phase_b_provider_bindings()') IS NOT NULL THEN
    RAISE EXCEPTION 'Phase B preflight: a Phase B helper/RPC already exists';
  END IF;
END
$phase_b_preflight$;

-- promo_codes predates stable source versioning. Add one owned version column
-- so quote fingerprints never have to guess whether a promotion changed.
ALTER TABLE public.promo_codes ADD COLUMN updated_at timestamptz;
UPDATE public.promo_codes
   SET updated_at = COALESCE(created_at, clock_timestamp());
ALTER TABLE public.promo_codes
  ALTER COLUMN updated_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN updated_at SET NOT NULL;

CREATE FUNCTION public.touch_promo_codes_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE TRIGGER promo_codes_touch_updated_at
  BEFORE UPDATE ON public.promo_codes
  FOR EACH ROW EXECUTE FUNCTION public.touch_promo_codes_updated_at();

-- These are safe because each leading id is already the table identity. They
-- provide composite FK targets that make tenant ownership database-enforced.
CREATE UNIQUE INDEX phase_b_branch_mappings_id_merchant_unique
  ON public.branch_mappings (id, merchant_id);
CREATE UNIQUE INDEX phase_b_products_id_merchant_unique
  ON public.products (id, merchant_id);
CREATE UNIQUE INDEX phase_b_merchant_qr_codes_id_merchant_branch_unique
  ON public.merchant_qr_codes (id, merchant_id, branch_id);

CREATE TABLE public.checkout_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  customer_id text,
  guest_session_id uuid,
  branch_id uuid NOT NULL,
  qr_code_id uuid,
  channel text NOT NULL,
  fulfillment_type text NOT NULL,
  delivery_latitude numeric(9, 6),
  delivery_longitude numeric(9, 6),
  delivery_zone_config_hash text,
  currency text NOT NULL DEFAULT 'SAR',
  subtotal_halala bigint NOT NULL,
  modifier_total_halala bigint NOT NULL DEFAULT 0,
  tax_halala bigint NOT NULL DEFAULT 0,
  delivery_fee_halala bigint NOT NULL DEFAULT 0,
  other_fee_halala bigint NOT NULL DEFAULT 0,
  promo_discount_halala bigint NOT NULL DEFAULT 0,
  reward_discount_halala bigint NOT NULL DEFAULT 0,
  other_discount_halala bigint NOT NULL DEFAULT 0,
  total_halala bigint NOT NULL,
  catalog_version text NOT NULL,
  pricing_version text NOT NULL,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_fingerprint text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL DEFAULT 'open',
  version integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  attempted_at timestamptz,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT checkout_quotes_identity_xor CHECK (
    (customer_id IS NOT NULL AND btrim(customer_id) <> '' AND guest_session_id IS NULL)
    OR (customer_id IS NULL AND guest_session_id IS NOT NULL)
  ),
  CONSTRAINT checkout_quotes_channel_valid CHECK (channel IN ('mobile', 'web', 'qr')),
  CONSTRAINT checkout_quotes_qr_channel_exact CHECK (
    (channel = 'qr' AND qr_code_id IS NOT NULL)
    OR (channel <> 'qr' AND qr_code_id IS NULL)
  ),
  CONSTRAINT checkout_quotes_fulfillment_valid CHECK (
    fulfillment_type IN ('delivery', 'pickup', 'drivethru', 'dine_in')
  ),
  CONSTRAINT checkout_quotes_delivery_binding_exact CHECK (
    (
      fulfillment_type = 'delivery'
      AND delivery_latitude IS NOT NULL
      AND delivery_longitude IS NOT NULL
      AND delivery_zone_config_hash IS NOT NULL
      AND delivery_latitude BETWEEN -90 AND 90
      AND delivery_longitude BETWEEN -180 AND 180
      AND delivery_zone_config_hash ~ '^[0-9a-f]{64}$'
    )
    OR (
      fulfillment_type <> 'delivery'
      AND delivery_latitude IS NULL
      AND delivery_longitude IS NULL
      AND delivery_zone_config_hash IS NULL
    )
  ),
  CONSTRAINT checkout_quotes_currency_sar CHECK (currency = 'SAR'),
  CONSTRAINT checkout_quotes_amounts_nonnegative CHECK (
    subtotal_halala >= 0
    AND modifier_total_halala >= 0
    AND tax_halala >= 0
    AND delivery_fee_halala >= 0
    AND other_fee_halala >= 0
    AND promo_discount_halala >= 0
    AND reward_discount_halala >= 0
    AND other_discount_halala >= 0
    AND total_halala >= 0
  ),
  CONSTRAINT checkout_quotes_total_exact CHECK (
    total_halala =
      subtotal_halala
      + modifier_total_halala
      + tax_halala
      + delivery_fee_halala
      + other_fee_halala
      - promo_discount_halala
      - reward_discount_halala
      - other_discount_halala
  ),
  CONSTRAINT checkout_quotes_discount_bounded CHECK (
    promo_discount_halala + reward_discount_halala + other_discount_halala
      <= subtotal_halala + modifier_total_halala + tax_halala
         + delivery_fee_halala + other_fee_halala
  ),
  CONSTRAINT checkout_quotes_versions_nonempty CHECK (
    btrim(catalog_version) <> '' AND btrim(pricing_version) <> ''
  ),
  CONSTRAINT checkout_quotes_source_snapshot_object CHECK (
    jsonb_typeof(source_snapshot) = 'object'
  ),
  CONSTRAINT checkout_quotes_fingerprint_sha256 CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT checkout_quotes_idempotency_key_valid CHECK (
    length(idempotency_key) BETWEEN 1 AND 128
  ),
  CONSTRAINT checkout_quotes_state_valid CHECK (
    state IN ('open', 'attempted', 'committed', 'expired', 'invalidated')
  ),
  CONSTRAINT checkout_quotes_version_positive CHECK (version >= 1),
  CONSTRAINT checkout_quotes_expiry_window CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '30 minutes'
  ),
  CONSTRAINT checkout_quotes_state_timestamps CHECK (
    (state <> 'attempted' OR attempted_at IS NOT NULL)
    AND (state <> 'committed' OR committed_at IS NOT NULL)
  ),
  CONSTRAINT checkout_quotes_id_merchant_unique UNIQUE (id, merchant_id),
  CONSTRAINT checkout_quotes_branch_merchant_fk
    FOREIGN KEY (branch_id, merchant_id)
    REFERENCES public.branch_mappings(id, merchant_id)
    ON DELETE RESTRICT,
  CONSTRAINT checkout_quotes_qr_merchant_branch_fk
    FOREIGN KEY (qr_code_id, merchant_id, branch_id)
    REFERENCES public.merchant_qr_codes(id, merchant_id, branch_id)
    ON DELETE RESTRICT,
  CONSTRAINT checkout_quotes_idempotency_unique UNIQUE (merchant_id, channel, idempotency_key)
);

CREATE INDEX checkout_quotes_customer_open_idx
  ON public.checkout_quotes (merchant_id, customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL AND state IN ('open', 'attempted');
CREATE INDEX checkout_quotes_guest_open_idx
  ON public.checkout_quotes (guest_session_id, created_at DESC)
  WHERE guest_session_id IS NOT NULL AND state IN ('open', 'attempted');
CREATE INDEX checkout_quotes_expiry_idx
  ON public.checkout_quotes (expires_at)
  WHERE state IN ('open', 'attempted');

CREATE TABLE public.checkout_quote_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  line_no integer NOT NULL,
  product_id uuid NOT NULL,
  foodics_product_id text NOT NULL,
  product_name text NOT NULL,
  quantity integer NOT NULL,
  base_unit_halala bigint NOT NULL,
  modifier_unit_halala bigint NOT NULL DEFAULT 0,
  base_total_halala bigint NOT NULL,
  modifier_total_halala bigint NOT NULL DEFAULT 0,
  tax_halala bigint NOT NULL DEFAULT 0,
  line_subtotal_halala bigint NOT NULL,
  line_discount_halala bigint NOT NULL DEFAULT 0,
  line_total_halala bigint NOT NULL,
  source_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT checkout_quote_lines_line_no_positive CHECK (line_no >= 1),
  CONSTRAINT checkout_quote_lines_quantity_bounded CHECK (quantity BETWEEN 1 AND 100),
  CONSTRAINT checkout_quote_lines_amounts_valid CHECK (
    base_unit_halala >= 0
    AND modifier_unit_halala >= 0
    AND base_total_halala >= 0
    AND modifier_total_halala >= 0
    AND tax_halala >= 0
    AND line_subtotal_halala >= 0
    AND line_discount_halala >= 0
    AND line_total_halala >= 0
    AND line_discount_halala <= line_subtotal_halala
    AND abs(base_total_halala - base_unit_halala * quantity) <= quantity
    AND abs(modifier_total_halala - modifier_unit_halala * quantity) <= quantity
    AND line_subtotal_halala =
      base_total_halala + modifier_total_halala + tax_halala
    AND line_total_halala = line_subtotal_halala - line_discount_halala
  ),
  CONSTRAINT checkout_quote_lines_names_nonempty CHECK (
    btrim(foodics_product_id) <> '' AND btrim(product_name) <> '' AND btrim(source_version) <> ''
  ),
  CONSTRAINT checkout_quote_lines_quote_line_unique UNIQUE (quote_id, line_no),
  CONSTRAINT checkout_quote_lines_id_quote_unique UNIQUE (id, quote_id),
  CONSTRAINT checkout_quote_lines_quote_merchant_fk
    FOREIGN KEY (quote_id, merchant_id)
    REFERENCES public.checkout_quotes(id, merchant_id)
    ON DELETE RESTRICT,
  CONSTRAINT checkout_quote_lines_product_merchant_fk
    FOREIGN KEY (product_id, merchant_id)
    REFERENCES public.products(id, merchant_id)
    ON DELETE RESTRICT
);

CREATE INDEX checkout_quote_lines_product_idx
  ON public.checkout_quote_lines (product_id);

CREATE TABLE public.checkout_quote_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_line_id uuid NOT NULL REFERENCES public.checkout_quote_lines(id) ON DELETE RESTRICT,
  option_no integer NOT NULL,
  group_id text NOT NULL,
  group_name text NOT NULL,
  option_id text NOT NULL,
  option_name text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  unit_price_halala bigint NOT NULL,
  total_halala bigint NOT NULL,
  source_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT checkout_quote_options_option_no_positive CHECK (option_no >= 1),
  CONSTRAINT checkout_quote_options_quantity_bounded CHECK (quantity BETWEEN 1 AND 100),
  CONSTRAINT checkout_quote_options_amounts_valid CHECK (
    unit_price_halala >= 0
    AND total_halala >= 0
    AND abs(total_halala - unit_price_halala * quantity) <= quantity
  ),
  CONSTRAINT checkout_quote_options_ids_nonempty CHECK (
    btrim(group_id) <> ''
    AND btrim(group_name) <> ''
    AND btrim(option_id) <> ''
    AND btrim(option_name) <> ''
    AND btrim(source_version) <> ''
  ),
  CONSTRAINT checkout_quote_options_line_no_unique UNIQUE (quote_line_id, option_no),
  CONSTRAINT checkout_quote_options_choice_unique UNIQUE (quote_line_id, group_id, option_id),
  CONSTRAINT checkout_quote_options_id_line_unique UNIQUE (id, quote_line_id)
);

CREATE TABLE public.checkout_quote_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES public.checkout_quotes(id) ON DELETE RESTRICT,
  adjustment_no integer NOT NULL,
  kind text NOT NULL,
  source_id text,
  code text,
  amount_halala bigint NOT NULL,
  source_version text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT checkout_quote_adjustments_no_positive CHECK (adjustment_no >= 1),
  CONSTRAINT checkout_quote_adjustments_kind_valid CHECK (
    kind IN ('promo_discount', 'reward_discount', 'other_discount', 'delivery_fee', 'other_fee')
  ),
  CONSTRAINT checkout_quote_adjustments_amount_positive CHECK (amount_halala > 0),
  CONSTRAINT checkout_quote_adjustments_source_required CHECK (
    kind NOT IN ('promo_discount', 'reward_discount') OR source_id IS NOT NULL
  ),
  CONSTRAINT checkout_quote_adjustments_promo_code_required CHECK (
    kind <> 'promo_discount' OR (code IS NOT NULL AND btrim(code) <> '')
  ),
  CONSTRAINT checkout_quote_adjustments_source_version_nonempty CHECK (btrim(source_version) <> ''),
  CONSTRAINT checkout_quote_adjustments_quote_no_unique UNIQUE (quote_id, adjustment_no)
);

CREATE TABLE public.payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  customer_id text,
  guest_session_id uuid,
  provider text NOT NULL,
  tender_type text NOT NULL,
  amount_halala bigint NOT NULL,
  currency text NOT NULL DEFAULT 'SAR',
  state text NOT NULL DEFAULT 'created',
  version integer NOT NULL DEFAULT 1,
  provider_payment_id text,
  provider_invoice_id text,
  metadata_nonce uuid NOT NULL DEFAULT gen_random_uuid(),
  return_url_key text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  provider_payload_sha256 text,
  last_error_code text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT payment_attempts_quote_merchant_fk
    FOREIGN KEY (quote_id, merchant_id)
    REFERENCES public.checkout_quotes(id, merchant_id)
    ON DELETE RESTRICT,
  CONSTRAINT payment_attempts_identity_xor CHECK (
    (customer_id IS NOT NULL AND btrim(customer_id) <> '' AND guest_session_id IS NULL)
    OR (customer_id IS NULL AND guest_session_id IS NOT NULL)
  ),
  CONSTRAINT payment_attempts_provider_valid CHECK (
    provider IN ('moyasar', 'cash', 'wallet', 'mixed', 'none')
  ),
  CONSTRAINT payment_attempts_tender_valid CHECK (
    tender_type IN ('card', 'apple_pay', 'saved_card', 'cash', 'wallet', 'cashback', 'mixed', 'none')
  ),
  CONSTRAINT payment_attempts_amount_nonnegative CHECK (amount_halala >= 0),
  CONSTRAINT payment_attempts_zero_provider_exact CHECK (
    (amount_halala = 0 AND provider = 'none' AND tender_type = 'none')
    OR (amount_halala > 0 AND provider <> 'none' AND tender_type <> 'none')
  ),
  CONSTRAINT payment_attempts_currency_sar CHECK (currency = 'SAR'),
  CONSTRAINT payment_attempts_state_valid CHECK (
    state IN (
      'created', 'provider_pending', 'authorized', 'captured', 'due',
      'failed', 'cancelled', 'expired', 'unknown', 'manual_review'
    )
  ),
  CONSTRAINT payment_attempts_version_positive CHECK (version >= 1),
  CONSTRAINT payment_attempts_return_url_key_valid CHECK (
    return_url_key IN ('als_app', 'web_order', 'none')
  ),
  CONSTRAINT payment_attempts_idempotency_key_valid CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  CONSTRAINT payment_attempts_fingerprint_sha256 CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT payment_attempts_payload_sha256 CHECK (
    provider_payload_sha256 IS NULL OR provider_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT payment_attempts_expiry_valid CHECK (expires_at > created_at),
  CONSTRAINT payment_attempts_id_merchant_unique UNIQUE (id, merchant_id),
  CONSTRAINT payment_attempts_idempotency_unique UNIQUE (merchant_id, idempotency_key)
);

CREATE UNIQUE INDEX payment_attempts_provider_payment_unique
  ON public.payment_attempts (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX payment_attempts_provider_invoice_unique
  ON public.payment_attempts (provider, provider_invoice_id)
  WHERE provider_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX payment_attempts_one_active_per_quote
  ON public.payment_attempts (quote_id)
  WHERE state IN (
    'created', 'provider_pending', 'authorized', 'captured', 'due',
    'unknown', 'manual_review'
  );
CREATE INDEX payment_attempts_quote_idx
  ON public.payment_attempts (quote_id, created_at DESC);
CREATE INDEX payment_attempts_reconcile_idx
  ON public.payment_attempts (state, updated_at)
  WHERE state IN ('provider_pending', 'authorized', 'unknown', 'manual_review');

CREATE TABLE public.payment_attempt_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.payment_attempts(id) ON DELETE RESTRICT,
  component_no integer NOT NULL,
  tender_type text NOT NULL,
  amount_halala bigint NOT NULL,
  collection_state text NOT NULL DEFAULT 'pending',
  reservation_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT payment_attempt_components_no_positive CHECK (component_no >= 1),
  CONSTRAINT payment_attempt_components_tender_valid CHECK (
    tender_type IN ('card', 'apple_pay', 'saved_card', 'cash', 'wallet', 'cashback')
  ),
  CONSTRAINT payment_attempt_components_amount_positive CHECK (amount_halala > 0),
  CONSTRAINT payment_attempt_components_state_valid CHECK (
    collection_state IN ('pending', 'reserved', 'authorized', 'captured', 'due', 'released', 'failed', 'unknown')
  ),
  CONSTRAINT payment_attempt_components_attempt_no_unique UNIQUE (attempt_id, component_no)
);

CREATE TABLE public.payment_attempt_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES public.payment_attempts(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_event_id text,
  provider_object_id text,
  event_type text NOT NULL,
  observed_state text NOT NULL,
  observed_amount_halala bigint,
  observed_currency text,
  observed_metadata_nonce uuid,
  payload_sha256 text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT payment_attempt_observations_provider_valid CHECK (provider IN ('moyasar', 'cash', 'wallet', 'mixed', 'none')),
  CONSTRAINT payment_attempt_observations_amount_nonnegative CHECK (
    observed_amount_halala IS NULL OR observed_amount_halala >= 0
  ),
  CONSTRAINT payment_attempt_observations_currency_valid CHECK (
    observed_currency IS NULL OR observed_currency = 'SAR'
  ),
  CONSTRAINT payment_attempt_observations_hash_sha256 CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX payment_attempt_observations_provider_event_unique
  ON public.payment_attempt_observations (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX payment_attempt_observations_attempt_idx
  ON public.payment_attempt_observations (attempt_id, observed_at DESC);

CREATE TABLE public.wallet_topup_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  customer_id text NOT NULL,
  amount_halala bigint NOT NULL,
  currency text NOT NULL DEFAULT 'SAR',
  provider text NOT NULL DEFAULT 'moyasar',
  saved_card_id text,
  state text NOT NULL DEFAULT 'created',
  version integer NOT NULL DEFAULT 1,
  provider_payment_id text,
  provider_invoice_id text,
  metadata_nonce uuid NOT NULL DEFAULT gen_random_uuid(),
  return_url_key text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  provider_payload_sha256 text,
  last_error_code text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT wallet_topup_intents_customer_nonempty CHECK (btrim(customer_id) <> ''),
  CONSTRAINT wallet_topup_intents_amount_positive CHECK (amount_halala > 0),
  CONSTRAINT wallet_topup_intents_currency_sar CHECK (currency = 'SAR'),
  CONSTRAINT wallet_topup_intents_provider_moyasar CHECK (provider = 'moyasar'),
  CONSTRAINT wallet_topup_intents_state_valid CHECK (
    state IN ('created', 'provider_pending', 'captured', 'credited', 'failed', 'cancelled', 'expired', 'unknown', 'manual_review')
  ),
  CONSTRAINT wallet_topup_intents_version_positive CHECK (version >= 1),
  CONSTRAINT wallet_topup_intents_return_url_key_valid CHECK (
    return_url_key IN ('als_app', 'web_order')
  ),
  CONSTRAINT wallet_topup_intents_idempotency_key_valid CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  CONSTRAINT wallet_topup_intents_fingerprint_sha256 CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wallet_topup_intents_payload_sha256 CHECK (
    provider_payload_sha256 IS NULL OR provider_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT wallet_topup_intents_expiry_valid CHECK (expires_at > created_at),
  CONSTRAINT wallet_topup_intents_idempotency_unique UNIQUE (merchant_id, customer_id, idempotency_key)
);

CREATE UNIQUE INDEX wallet_topup_intents_provider_payment_unique
  ON public.wallet_topup_intents (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX wallet_topup_intents_provider_invoice_unique
  ON public.wallet_topup_intents (provider, provider_invoice_id)
  WHERE provider_invoice_id IS NOT NULL;
CREATE INDEX wallet_topup_intents_reconcile_idx
  ON public.wallet_topup_intents (state, updated_at)
  WHERE state IN ('provider_pending', 'captured', 'unknown', 'manual_review');

-- One provider object can fund exactly one economic domain. Per-table unique
-- indexes cannot prevent a Moyasar id from being reused for both an order and
-- a wallet top-up, so trigger-owned bindings share a single primary key.
CREATE TABLE public.provider_object_bindings (
  provider text NOT NULL,
  object_kind text NOT NULL,
  provider_object_id text NOT NULL,
  source_domain text NOT NULL,
  source_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_object_bindings_pk
    PRIMARY KEY (provider, object_kind, provider_object_id),
  CONSTRAINT provider_object_bindings_provider_nonempty CHECK (btrim(provider) <> ''),
  CONSTRAINT provider_object_bindings_kind_valid CHECK (object_kind IN ('payment', 'invoice')),
  CONSTRAINT provider_object_bindings_id_nonempty CHECK (btrim(provider_object_id) <> ''),
  CONSTRAINT provider_object_bindings_domain_valid CHECK (
    source_domain IN ('payment_attempt', 'wallet_topup')
  ),
  CONSTRAINT provider_object_bindings_source_kind_unique
    UNIQUE (source_domain, source_id, object_kind)
);

ALTER TABLE public.customer_orders
  ADD COLUMN checkout_quote_id uuid,
  ADD COLUMN payment_attempt_id uuid,
  ADD COLUMN total_halala bigint,
  ADD COLUMN currency text,
  ADD COLUMN collection_state text,
  ADD COLUMN delivery_latitude numeric(9, 6),
  ADD COLUMN delivery_longitude numeric(9, 6),
  ADD COLUMN delivery_zone_config_hash text,
  ADD COLUMN fulfillment_authorized_at timestamptz;

ALTER TABLE public.customer_orders
  ADD CONSTRAINT customer_orders_checkout_quote_fk
    FOREIGN KEY (checkout_quote_id) REFERENCES public.checkout_quotes(id) ON DELETE RESTRICT,
  ADD CONSTRAINT customer_orders_payment_attempt_fk
    FOREIGN KEY (payment_attempt_id) REFERENCES public.payment_attempts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT customer_orders_total_halala_nonnegative CHECK (
    total_halala IS NULL OR total_halala >= 0
  ),
  ADD CONSTRAINT customer_orders_currency_sar CHECK (
    currency IS NULL OR currency = 'SAR'
  ),
  ADD CONSTRAINT customer_orders_collection_state_valid CHECK (
    collection_state IS NULL OR collection_state IN ('due_at_merchant', 'settled', 'partially_settled', 'unknown')
  ),
  ADD CONSTRAINT customer_orders_delivery_location_valid CHECK (
    (delivery_latitude IS NULL AND delivery_longitude IS NULL AND delivery_zone_config_hash IS NULL)
    OR (
      delivery_latitude IS NOT NULL
      AND delivery_longitude IS NOT NULL
      AND delivery_zone_config_hash IS NOT NULL
      AND delivery_latitude BETWEEN -90 AND 90
      AND delivery_longitude BETWEEN -180 AND 180
      AND delivery_zone_config_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT customer_orders_quote_link_complete CHECK (
    checkout_quote_id IS NULL
    OR (
      payment_attempt_id IS NOT NULL
      AND total_halala IS NOT NULL
      AND currency = 'SAR'
      AND collection_state IS NOT NULL
    )
  );

CREATE UNIQUE INDEX customer_orders_checkout_quote_unique
  ON public.customer_orders (checkout_quote_id)
  WHERE checkout_quote_id IS NOT NULL;
CREATE UNIQUE INDEX customer_orders_payment_attempt_unique
  ON public.customer_orders (payment_attempt_id)
  WHERE payment_attempt_id IS NOT NULL;

CREATE TABLE public.order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL REFERENCES public.customer_orders(id) ON DELETE RESTRICT,
  checkout_quote_id uuid NOT NULL,
  checkout_quote_line_id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  line_no integer NOT NULL,
  product_id uuid NOT NULL,
  foodics_product_id text NOT NULL,
  product_name text NOT NULL,
  quantity integer NOT NULL,
  base_unit_halala bigint NOT NULL,
  modifier_unit_halala bigint NOT NULL DEFAULT 0,
  base_total_halala bigint NOT NULL,
  modifier_total_halala bigint NOT NULL DEFAULT 0,
  tax_halala bigint NOT NULL DEFAULT 0,
  line_subtotal_halala bigint NOT NULL,
  line_discount_halala bigint NOT NULL DEFAULT 0,
  line_total_halala bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_lines_quote_line_fk
    FOREIGN KEY (checkout_quote_line_id, checkout_quote_id)
    REFERENCES public.checkout_quote_lines(id, quote_id)
    ON DELETE RESTRICT,
  CONSTRAINT order_lines_quote_merchant_fk
    FOREIGN KEY (checkout_quote_id, merchant_id)
    REFERENCES public.checkout_quotes(id, merchant_id)
    ON DELETE RESTRICT,
  CONSTRAINT order_lines_product_merchant_fk
    FOREIGN KEY (product_id, merchant_id)
    REFERENCES public.products(id, merchant_id)
    ON DELETE RESTRICT,
  CONSTRAINT order_lines_line_no_positive CHECK (line_no >= 1),
  CONSTRAINT order_lines_quantity_bounded CHECK (quantity BETWEEN 1 AND 100),
  CONSTRAINT order_lines_amounts_valid CHECK (
    base_unit_halala >= 0
    AND modifier_unit_halala >= 0
    AND base_total_halala >= 0
    AND modifier_total_halala >= 0
    AND tax_halala >= 0
    AND line_subtotal_halala >= 0
    AND line_discount_halala >= 0
    AND line_discount_halala <= line_subtotal_halala
    AND abs(base_total_halala - base_unit_halala * quantity) <= quantity
    AND abs(modifier_total_halala - modifier_unit_halala * quantity) <= quantity
    AND line_subtotal_halala =
      base_total_halala + modifier_total_halala + tax_halala
    AND line_total_halala = line_subtotal_halala - line_discount_halala
  ),
  CONSTRAINT order_lines_order_line_unique UNIQUE (order_id, line_no),
  CONSTRAINT order_lines_quote_source_unique UNIQUE (checkout_quote_line_id),
  CONSTRAINT order_lines_id_order_unique UNIQUE (id, order_id),
  CONSTRAINT order_lines_id_quote_line_unique UNIQUE (id, checkout_quote_line_id)
);

CREATE INDEX order_lines_quote_idx ON public.order_lines (checkout_quote_id, line_no);

CREATE TABLE public.order_line_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id uuid NOT NULL,
  checkout_quote_line_id uuid NOT NULL,
  checkout_quote_option_id uuid NOT NULL,
  option_no integer NOT NULL,
  group_id text NOT NULL,
  group_name text NOT NULL,
  option_id text NOT NULL,
  option_name text NOT NULL,
  quantity integer NOT NULL,
  unit_price_halala bigint NOT NULL,
  total_halala bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_line_options_order_line_fk
    FOREIGN KEY (order_line_id, checkout_quote_line_id)
    REFERENCES public.order_lines(id, checkout_quote_line_id)
    ON DELETE RESTRICT,
  CONSTRAINT order_line_options_quote_option_fk
    FOREIGN KEY (checkout_quote_option_id, checkout_quote_line_id)
    REFERENCES public.checkout_quote_options(id, quote_line_id)
    ON DELETE RESTRICT,
  CONSTRAINT order_line_options_option_no_positive CHECK (option_no >= 1),
  CONSTRAINT order_line_options_quantity_bounded CHECK (quantity BETWEEN 1 AND 100),
  CONSTRAINT order_line_options_amounts_valid CHECK (
    unit_price_halala >= 0
    AND total_halala >= 0
    AND abs(total_halala - unit_price_halala * quantity) <= quantity
  ),
  CONSTRAINT order_line_options_order_no_unique UNIQUE (order_line_id, option_no),
  CONSTRAINT order_line_options_quote_source_unique UNIQUE (checkout_quote_option_id)
);

-- Child economics and provider observations are append-only.
CREATE FUNCTION public.reject_phase_b_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Phase B immutable row: %.% may not be %d', TG_TABLE_SCHEMA, TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION public.bind_phase_b_provider_object(
  p_provider text,
  p_object_kind text,
  p_provider_object_id text,
  p_source_domain text,
  p_source_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  binding_row public.provider_object_bindings%ROWTYPE;
BEGIN
  IF p_provider_object_id IS NULL THEN
    RETURN;
  END IF;
  IF btrim(p_provider_object_id) = '' THEN
    RAISE EXCEPTION 'provider object id may not be empty' USING ERRCODE = '23514';
  END IF;

  -- Serialize the absent-row case as well as the registry insert. The primary
  -- key is the final authority; this advisory lock makes conflicts deterministic.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_provider || ':' || p_object_kind || ':' || p_provider_object_id,
      0
    )
  );
  INSERT INTO public.provider_object_bindings (
    provider, object_kind, provider_object_id, source_domain, source_id
  ) VALUES (
    p_provider, p_object_kind, p_provider_object_id, p_source_domain, p_source_id
  )
  ON CONFLICT (provider, object_kind, provider_object_id) DO NOTHING;

  SELECT * INTO binding_row
    FROM public.provider_object_bindings
   WHERE provider = p_provider
     AND object_kind = p_object_kind
     AND provider_object_id = p_provider_object_id
   FOR UPDATE;

  IF binding_row.source_domain IS DISTINCT FROM p_source_domain
     OR binding_row.source_id IS DISTINCT FROM p_source_id THEN
    RAISE EXCEPTION 'provider object is already bound to another economic domain'
      USING ERRCODE = '23505';
  END IF;
END
$function$;

CREATE FUNCTION public.enforce_phase_b_provider_bindings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  source_domain text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' THEN
    RAISE EXCEPTION 'provider binding trigger attached outside public schema'
      USING ERRCODE = '55000';
  END IF;
  source_domain := CASE TG_TABLE_NAME
    WHEN 'payment_attempts' THEN 'payment_attempt'
    WHEN 'wallet_topup_intents' THEN 'wallet_topup'
    ELSE NULL
  END;
  IF source_domain IS NULL THEN
    RAISE EXCEPTION 'provider binding trigger attached to unexpected table %', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.bind_phase_b_provider_object(
    NEW.provider, 'payment', NEW.provider_payment_id, source_domain, NEW.id
  );
  PERFORM public.bind_phase_b_provider_object(
    NEW.provider, 'invoice', NEW.provider_invoice_id, source_domain, NEW.id
  );
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.enforce_checkout_quote_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'checkout_quotes are durable and may not be deleted' USING ERRCODE = '55000';
  END IF;

  IF (to_jsonb(NEW) - ARRAY['state', 'version', 'attempted_at', 'committed_at', 'updated_at'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state', 'version', 'attempted_at', 'committed_at', 'updated_at']) THEN
    RAISE EXCEPTION 'checkout quote economics and identity are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'checkout quote transition requires version + 1' USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (OLD.state = 'open' AND NEW.state IN ('attempted', 'expired', 'invalidated'))
    OR (OLD.state = 'attempted' AND NEW.state IN ('committed', 'expired', 'invalidated'))
  ) THEN
    RAISE EXCEPTION 'illegal checkout quote transition: % -> %', OLD.state, NEW.state USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.enforce_payment_attempt_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_attempts are durable and may not be deleted' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY[
        'state', 'version', 'provider_payment_id', 'provider_invoice_id',
        'provider_payload_sha256', 'last_error_code', 'updated_at'
      ]) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'state', 'version', 'provider_payment_id', 'provider_invoice_id',
        'provider_payload_sha256', 'last_error_code', 'updated_at'
      ]) THEN
    RAISE EXCEPTION 'payment attempt economics and binding are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
    RAISE EXCEPTION 'provider_payment_id is write-once' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_invoice_id IS NOT NULL AND NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id THEN
    RAISE EXCEPTION 'provider_invoice_id is write-once' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'payment attempt transition requires version + 1' USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (OLD.state = 'created' AND NEW.state IN ('provider_pending', 'due', 'cancelled', 'expired'))
    OR (OLD.state = 'provider_pending' AND NEW.state IN ('authorized', 'captured', 'failed', 'cancelled', 'unknown'))
    OR (OLD.state = 'authorized' AND NEW.state IN ('captured', 'failed', 'cancelled', 'unknown'))
    OR (OLD.state = 'due' AND NEW.state IN ('captured', 'cancelled'))
    OR (OLD.state = 'unknown' AND NEW.state IN ('provider_pending', 'authorized', 'captured', 'failed', 'cancelled', 'manual_review'))
    OR (OLD.state = 'manual_review' AND NEW.state IN ('captured', 'failed', 'cancelled', 'unknown'))
  ) THEN
    RAISE EXCEPTION 'illegal payment attempt transition: % -> %', OLD.state, NEW.state USING ERRCODE = '22023';
  END IF;

  -- Mixed-tender attempts are schema-representable (provider_payment_id /
  -- provider_payload_sha256 live on the ATTEMPT row, but amount_halala is
  -- the FULL attempt total across all components — not the Moyasar-backed
  -- component's sub-amount). The exact-observation match below compares
  -- against the full attempt amount, so it can never legitimately match a
  -- mixed attempt's partial Moyasar charge; per-component settlement
  -- evidence (each component proving its own provider leg) is not yet
  -- implemented. Explicitly refuse capture for 'mixed' rather than letting
  -- a bare webhook UPDATE silently bypass the moyasar-only guard below —
  -- audit finding 2026-07-15: this branch was previously unreachable
  -- (provider='moyasar' only), leaving 'mixed' free to reach 'captured'
  -- via any UPDATE with zero settlement evidence.
  IF NEW.state = 'captured' AND NEW.provider = 'mixed' THEN
    RAISE EXCEPTION 'mixed-provider capture requires per-component settlement evidence, which is not yet implemented; this attempt type cannot be captured'
      USING ERRCODE = '0A000';
  END IF;

  -- A Moyasar state label is not settlement evidence by itself. The
  -- application must first append an exact provider observation, including
  -- the attempt nonce, SAR amount, provider object id, and payload digest.
  -- This prevents a service bug (or a compromised internal caller) from
  -- turning provider_pending/unknown into captured with a bare UPDATE.
  IF NEW.state = 'captured' AND NEW.provider = 'moyasar' THEN
    IF NEW.provider_payment_id IS NULL OR NEW.provider_payload_sha256 IS NULL THEN
      RAISE EXCEPTION 'captured Moyasar attempt requires a provider payment id and payload digest'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.payment_attempt_observations AS observation
       WHERE observation.attempt_id = NEW.id
         AND observation.provider = NEW.provider
         AND observation.provider_object_id = NEW.provider_payment_id
         AND observation.observed_state IN ('paid', 'captured')
         AND observation.observed_amount_halala = NEW.amount_halala
         AND observation.observed_currency = NEW.currency
         AND observation.observed_metadata_nonce = NEW.metadata_nonce
         AND observation.payload_sha256 = NEW.provider_payload_sha256
    ) THEN
      RAISE EXCEPTION 'captured Moyasar attempt requires an exact terminal provider observation'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.enforce_payment_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  quote_row public.checkout_quotes%ROWTYPE;
BEGIN
  SELECT *
    INTO quote_row
    FROM public.checkout_quotes
   WHERE id = NEW.quote_id
   FOR SHARE;

  IF NOT FOUND
     OR quote_row.merchant_id <> NEW.merchant_id
     OR quote_row.customer_id IS DISTINCT FROM NEW.customer_id
     OR quote_row.guest_session_id IS DISTINCT FROM NEW.guest_session_id
     OR quote_row.total_halala <> NEW.amount_halala
     OR quote_row.currency <> NEW.currency THEN
    RAISE EXCEPTION 'payment attempt must exactly bind one quote identity and amount'
      USING ERRCODE = '23514';
  END IF;
  IF quote_row.state NOT IN ('open', 'attempted') OR quote_row.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'payment attempt cannot bind an inactive or expired quote'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (NEW.provider = 'cash' AND NEW.tender_type = 'cash')
    OR (NEW.provider = 'moyasar' AND NEW.tender_type IN ('card', 'apple_pay', 'saved_card'))
    OR (NEW.provider = 'wallet' AND NEW.tender_type IN ('wallet', 'cashback'))
    OR (NEW.provider = 'mixed' AND NEW.tender_type = 'mixed')
    OR (NEW.provider = 'none' AND NEW.tender_type = 'none' AND NEW.amount_halala = 0)
  ) THEN
    RAISE EXCEPTION 'payment provider and tender type are inconsistent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.enforce_attempt_component_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment attempt components are durable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['collection_state', 'reservation_id', 'updated_at'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['collection_state', 'reservation_id', 'updated_at']) THEN
    RAISE EXCEPTION 'payment attempt component economics are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.reservation_id IS NOT NULL AND NEW.reservation_id IS DISTINCT FROM OLD.reservation_id THEN
    RAISE EXCEPTION 'component reservation_id is write-once' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.collection_state = 'pending' AND NEW.collection_state IN ('reserved', 'authorized', 'captured', 'due', 'failed', 'unknown'))
    OR (OLD.collection_state = 'reserved' AND NEW.collection_state IN ('authorized', 'captured', 'released', 'failed', 'unknown'))
    OR (OLD.collection_state = 'authorized' AND NEW.collection_state IN ('captured', 'released', 'failed', 'unknown'))
    OR (OLD.collection_state = 'due' AND NEW.collection_state IN ('captured', 'released'))
    OR (OLD.collection_state = 'unknown' AND NEW.collection_state IN ('reserved', 'authorized', 'captured', 'released', 'failed'))
  ) THEN
    RAISE EXCEPTION 'illegal attempt component transition: % -> %', OLD.collection_state, NEW.collection_state
      USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.enforce_wallet_topup_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallet_topup_intents are durable and may not be deleted' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY[
        'state', 'version', 'provider_payment_id', 'provider_invoice_id',
        'provider_payload_sha256', 'last_error_code', 'updated_at'
      ]) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'state', 'version', 'provider_payment_id', 'provider_invoice_id',
        'provider_payload_sha256', 'last_error_code', 'updated_at'
      ]) THEN
    RAISE EXCEPTION 'wallet top-up economics and binding are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
    RAISE EXCEPTION 'top-up provider_payment_id is write-once' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_invoice_id IS NOT NULL AND NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id THEN
    RAISE EXCEPTION 'top-up provider_invoice_id is write-once' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'wallet top-up transition requires version + 1' USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (OLD.state = 'created' AND NEW.state IN ('provider_pending', 'cancelled', 'expired'))
    OR (OLD.state = 'provider_pending' AND NEW.state IN ('captured', 'failed', 'cancelled', 'unknown'))
    OR (OLD.state = 'captured' AND NEW.state IN ('credited', 'unknown', 'manual_review'))
    OR (OLD.state = 'unknown' AND NEW.state IN ('provider_pending', 'captured', 'failed', 'cancelled', 'manual_review'))
    OR (OLD.state = 'manual_review' AND NEW.state IN ('captured', 'credited', 'failed', 'cancelled', 'unknown'))
  ) THEN
    RAISE EXCEPTION 'illegal wallet top-up transition: % -> %', OLD.state, NEW.state USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE FUNCTION public.enforce_quote_backed_order_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  quote_row public.checkout_quotes%ROWTYPE;
  attempt_row public.payment_attempts%ROWTYPE;
BEGIN
  IF NEW.checkout_quote_id IS NULL THEN
    IF NEW.payment_attempt_id IS NOT NULL THEN
      RAISE EXCEPTION 'payment_attempt_id requires checkout_quote_id' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO quote_row
    FROM public.checkout_quotes
   WHERE id = NEW.checkout_quote_id
   FOR SHARE;
  SELECT * INTO attempt_row
    FROM public.payment_attempts
   WHERE id = NEW.payment_attempt_id
   FOR SHARE;

  IF quote_row.id IS NULL
     OR attempt_row.id IS NULL
     OR attempt_row.quote_id <> quote_row.id
     OR quote_row.merchant_id::text IS DISTINCT FROM NEW.merchant_id
     OR NOT (
       quote_row.customer_id IS NOT DISTINCT FROM NEW.customer_id
       OR (quote_row.customer_id IS NULL AND NEW.customer_id = 'guest')
     )
     OR attempt_row.merchant_id <> quote_row.merchant_id
     OR NEW.branch_id IS DISTINCT FROM quote_row.branch_id::text
     OR NEW.order_type IS DISTINCT FROM quote_row.fulfillment_type
     OR NEW.delivery_latitude IS DISTINCT FROM quote_row.delivery_latitude
     OR NEW.delivery_longitude IS DISTINCT FROM quote_row.delivery_longitude
     OR NEW.delivery_zone_config_hash IS DISTINCT FROM quote_row.delivery_zone_config_hash
     OR NEW.total_halala <> quote_row.total_halala
     OR NEW.total_halala <> attempt_row.amount_halala
     OR NEW.total_sar <> NEW.total_halala::numeric / 100
     OR NEW.currency <> quote_row.currency
     OR NEW.currency <> attempt_row.currency THEN
    RAISE EXCEPTION 'quote-backed order identity and economics do not match'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.collection_state = 'settled' AND attempt_row.state <> 'captured' THEN
    RAISE EXCEPTION 'settled order requires captured payment attempt' USING ERRCODE = '23514';
  END IF;
  IF NEW.collection_state = 'settled'
     AND (NEW.payment_confirmed_at IS NULL OR NEW.fulfillment_authorized_at IS NULL) THEN
    RAISE EXCEPTION 'settled order requires payment and fulfillment authorization timestamps'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.collection_state = 'due_at_merchant'
     AND NOT (attempt_row.state = 'due' AND attempt_row.tender_type = 'cash') THEN
    RAISE EXCEPTION 'due-at-merchant order requires a due cash attempt' USING ERRCODE = '23514';
  END IF;
  IF NEW.collection_state = 'due_at_merchant'
     AND (NEW.payment_confirmed_at IS NOT NULL OR NEW.fulfillment_authorized_at IS NULL) THEN
    RAISE EXCEPTION 'due-at-merchant cash must be fulfillment-authorized but never payment-confirmed'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.collection_state = 'unknown'
     AND attempt_row.state NOT IN ('unknown', 'manual_review') THEN
    RAISE EXCEPTION 'unknown collection state requires an unknown/manual-review attempt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER checkout_quotes_guard
  BEFORE UPDATE OR DELETE ON public.checkout_quotes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_checkout_quote_transition();
CREATE TRIGGER payment_attempts_guard
  BEFORE UPDATE OR DELETE ON public.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_attempt_transition();
CREATE TRIGGER payment_attempts_insert_guard
  BEFORE INSERT ON public.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_attempt_insert();
CREATE TRIGGER payment_attempts_provider_binding
  BEFORE INSERT OR UPDATE ON public.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_phase_b_provider_bindings();
CREATE TRIGGER payment_attempt_components_guard
  BEFORE UPDATE OR DELETE ON public.payment_attempt_components
  FOR EACH ROW EXECUTE FUNCTION public.enforce_attempt_component_transition();
CREATE TRIGGER wallet_topup_intents_guard
  BEFORE UPDATE OR DELETE ON public.wallet_topup_intents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_wallet_topup_transition();
CREATE TRIGGER wallet_topup_intents_provider_binding
  BEFORE INSERT OR UPDATE ON public.wallet_topup_intents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_phase_b_provider_bindings();
CREATE TRIGGER provider_object_bindings_immutable
  BEFORE UPDATE OR DELETE ON public.provider_object_bindings
  FOR EACH ROW EXECUTE FUNCTION public.reject_phase_b_immutable_mutation();

CREATE TRIGGER checkout_quote_lines_immutable
  BEFORE UPDATE OR DELETE ON public.checkout_quote_lines
  FOR EACH ROW EXECUTE FUNCTION public.reject_phase_b_immutable_mutation();
CREATE TRIGGER checkout_quote_options_immutable
  BEFORE UPDATE OR DELETE ON public.checkout_quote_options
  FOR EACH ROW EXECUTE FUNCTION public.reject_phase_b_immutable_mutation();
CREATE TRIGGER checkout_quote_adjustments_immutable
  BEFORE UPDATE OR DELETE ON public.checkout_quote_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.reject_phase_b_immutable_mutation();
CREATE TRIGGER payment_attempt_observations_immutable
  BEFORE UPDATE OR DELETE ON public.payment_attempt_observations
  FOR EACH ROW EXECUTE FUNCTION public.reject_phase_b_immutable_mutation();
CREATE TRIGGER order_lines_immutable
  BEFORE UPDATE OR DELETE ON public.order_lines
  FOR EACH ROW EXECUTE FUNCTION public.reject_phase_b_immutable_mutation();
CREATE TRIGGER order_line_options_immutable
  BEFORE UPDATE OR DELETE ON public.order_line_options
  FOR EACH ROW EXECUTE FUNCTION public.reject_phase_b_immutable_mutation();
CREATE TRIGGER customer_orders_quote_link_guard
  -- Fire on every update, not only link-column updates. Otherwise a later
  -- total_sar/merchant/customer/branch/order_type change could bypass the
  -- quote/attempt equality checks while leaving the link columns untouched.
  BEFORE INSERT OR UPDATE
  ON public.customer_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_quote_backed_order_link();

-- Atomic idempotent quote persistence. The application prices first, then this
-- RPC either persists the complete immutable graph or leaves no partial rows.
CREATE FUNCTION public.persist_checkout_quote(
  p_quote jsonb,
  p_lines jsonb,
  p_adjustments jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_quote_id uuid;
  v_existing_id uuid;
  v_existing_fingerprint text;
  v_line jsonb;
  v_option jsonb;
  v_adjustment jsonb;
  v_line_id uuid;
  v_line_subtotal bigint;
  v_line_modifier_total bigint;
  v_line_tax_total bigint;
  v_promo_adjustment_total bigint;
  v_reward_adjustment_total bigint;
  v_other_discount_total bigint;
  v_delivery_gross bigint;
BEGIN
  IF jsonb_typeof(p_quote) <> 'object'
     OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) = 0
     OR jsonb_typeof(p_adjustments) <> 'array' THEN
    RAISE EXCEPTION 'persist_checkout_quote requires an object quote and non-empty line array'
      USING ERRCODE = '22023';
  END IF;

  v_quote_id := COALESCE(NULLIF(p_quote->>'id', '')::uuid, gen_random_uuid());
  v_delivery_gross := COALESCE(
    (p_quote->'source_snapshot'->>'delivery_fee_gross_halala')::bigint,
    COALESCE((p_quote->>'delivery_fee_halala')::bigint, 0)
  );
  IF v_delivery_gross < COALESCE((p_quote->>'delivery_fee_halala')::bigint, 0) THEN
    RAISE EXCEPTION 'delivery gross cannot be below delivery net' USING ERRCODE = '23514';
  END IF;

  -- Serialize a merchant/channel/idempotency key so simultaneous identical
  -- requests cannot race between the lookup and unique insert.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      (p_quote->>'merchant_id') || ':' || (p_quote->>'channel') || ':' || (p_quote->>'idempotency_key'),
      0
    )
  );

  SELECT q.id, q.request_fingerprint
    INTO v_existing_id, v_existing_fingerprint
    FROM public.checkout_quotes AS q
   WHERE q.merchant_id = (p_quote->>'merchant_id')::uuid
     AND q.channel = p_quote->>'channel'
     AND q.idempotency_key = p_quote->>'idempotency_key';

  IF FOUND THEN
    IF v_existing_fingerprint IS DISTINCT FROM p_quote->>'request_fingerprint' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing_id;
  END IF;

  INSERT INTO public.checkout_quotes (
    id, merchant_id, customer_id, guest_session_id, branch_id, qr_code_id,
    channel, fulfillment_type,
    delivery_latitude, delivery_longitude, delivery_zone_config_hash, currency,
    subtotal_halala, modifier_total_halala, tax_halala,
    delivery_fee_halala, other_fee_halala,
    promo_discount_halala, reward_discount_halala, other_discount_halala,
    total_halala, catalog_version, pricing_version, source_snapshot,
    request_fingerprint, idempotency_key, expires_at
  ) VALUES (
    v_quote_id,
    (p_quote->>'merchant_id')::uuid,
    NULLIF(p_quote->>'customer_id', ''),
    NULLIF(p_quote->>'guest_session_id', '')::uuid,
    (p_quote->>'branch_id')::uuid,
    NULLIF(p_quote->>'qr_code_id', '')::uuid,
    p_quote->>'channel',
    p_quote->>'fulfillment_type',
    NULLIF(p_quote->>'delivery_latitude', '')::numeric,
    NULLIF(p_quote->>'delivery_longitude', '')::numeric,
    NULLIF(p_quote->>'delivery_zone_config_hash', ''),
    COALESCE(NULLIF(p_quote->>'currency', ''), 'SAR'),
    (p_quote->>'subtotal_halala')::bigint,
    COALESCE((p_quote->>'modifier_total_halala')::bigint, 0),
    COALESCE((p_quote->>'tax_halala')::bigint, 0),
    COALESCE((p_quote->>'delivery_fee_halala')::bigint, 0),
    COALESCE((p_quote->>'other_fee_halala')::bigint, 0),
    COALESCE((p_quote->>'promo_discount_halala')::bigint, 0),
    COALESCE((p_quote->>'reward_discount_halala')::bigint, 0),
    COALESCE((p_quote->>'other_discount_halala')::bigint, 0),
    (p_quote->>'total_halala')::bigint,
    p_quote->>'catalog_version',
    p_quote->>'pricing_version',
    COALESCE(p_quote->'source_snapshot', '{}'::jsonb),
    p_quote->>'request_fingerprint',
    p_quote->>'idempotency_key',
    (p_quote->>'expires_at')::timestamptz
  );

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    IF jsonb_typeof(COALESCE(v_line->'options', '[]'::jsonb)) <> 'array' THEN
      RAISE EXCEPTION 'line options must be an array' USING ERRCODE = '22023';
    END IF;
    v_line_id := gen_random_uuid();
    INSERT INTO public.checkout_quote_lines (
      id, quote_id, merchant_id, line_no, product_id, foodics_product_id, product_name,
      quantity, base_unit_halala, modifier_unit_halala,
      base_total_halala, modifier_total_halala, tax_halala,
      line_subtotal_halala, line_discount_halala, line_total_halala, source_version
    ) VALUES (
      v_line_id,
      v_quote_id,
      (p_quote->>'merchant_id')::uuid,
      (v_line->>'line_no')::integer,
      (v_line->>'product_id')::uuid,
      v_line->>'foodics_product_id',
      v_line->>'product_name',
      (v_line->>'quantity')::integer,
      (v_line->>'base_unit_halala')::bigint,
      COALESCE((v_line->>'modifier_unit_halala')::bigint, 0),
      (v_line->>'base_total_halala')::bigint,
      COALESCE((v_line->>'modifier_total_halala')::bigint, 0),
      COALESCE((v_line->>'tax_halala')::bigint, 0),
      (v_line->>'line_subtotal_halala')::bigint,
      COALESCE((v_line->>'line_discount_halala')::bigint, 0),
      (v_line->>'line_total_halala')::bigint,
      v_line->>'source_version'
    );

    FOR v_option IN
      SELECT value FROM jsonb_array_elements(COALESCE(v_line->'options', '[]'::jsonb))
    LOOP
      INSERT INTO public.checkout_quote_options (
        quote_line_id, option_no, group_id, group_name, option_id, option_name,
        quantity, unit_price_halala, total_halala, source_version
      ) VALUES (
        v_line_id,
        (v_option->>'option_no')::integer,
        v_option->>'group_id',
        v_option->>'group_name',
        v_option->>'option_id',
        v_option->>'option_name',
        COALESCE((v_option->>'quantity')::integer, 1),
        (v_option->>'unit_price_halala')::bigint,
        (v_option->>'total_halala')::bigint,
        v_option->>'source_version'
      );
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM public.checkout_quote_lines AS line
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(sum(option_row.unit_price_halala), 0) AS unit_total,
          COALESCE(sum(option_row.total_halala), 0) AS allocated_total,
          bool_and(option_row.quantity = line.quantity) AS quantities_match
          FROM public.checkout_quote_options AS option_row
         WHERE option_row.quote_line_id = line.id
      ) AS option_graph ON true
     WHERE line.quote_id = v_quote_id
       AND (
         option_graph.unit_total <> line.modifier_unit_halala
         OR option_graph.allocated_total <> line.modifier_total_halala
         OR option_graph.quantities_match IS FALSE
       )
  ) THEN
    RAISE EXCEPTION 'quote option allocations do not exactly match their modifier line'
      USING ERRCODE = '23514';
  END IF;

  FOR v_adjustment IN SELECT value FROM jsonb_array_elements(p_adjustments)
  LOOP
    INSERT INTO public.checkout_quote_adjustments (
      quote_id, adjustment_no, kind, source_id, code, amount_halala,
      source_version, metadata
    ) VALUES (
      v_quote_id,
      (v_adjustment->>'adjustment_no')::integer,
      v_adjustment->>'kind',
      NULLIF(v_adjustment->>'source_id', ''),
      NULLIF(v_adjustment->>'code', ''),
      (v_adjustment->>'amount_halala')::bigint,
      v_adjustment->>'source_version',
      COALESCE(v_adjustment->'metadata', '{}'::jsonb)
    );
  END LOOP;

  SELECT
    COALESCE(sum(base_total_halala), 0),
    COALESCE(sum(modifier_total_halala), 0),
    COALESCE(sum(tax_halala), 0)
    INTO v_line_subtotal, v_line_modifier_total, v_line_tax_total
    FROM public.checkout_quote_lines
   WHERE quote_id = v_quote_id;

  SELECT
    COALESCE(sum(amount_halala) FILTER (WHERE kind = 'promo_discount'), 0),
    COALESCE(sum(amount_halala) FILTER (WHERE kind = 'reward_discount'), 0),
    COALESCE(sum(amount_halala) FILTER (WHERE kind = 'other_discount'), 0)
    INTO v_promo_adjustment_total, v_reward_adjustment_total, v_other_discount_total
    FROM public.checkout_quote_adjustments
   WHERE quote_id = v_quote_id;

  IF v_line_subtotal <> (p_quote->>'subtotal_halala')::bigint
     OR v_line_modifier_total <> COALESCE((p_quote->>'modifier_total_halala')::bigint, 0)
     OR v_line_tax_total
          + v_delivery_gross
          - COALESCE((p_quote->>'delivery_fee_halala')::bigint, 0)
        <> COALESCE((p_quote->>'tax_halala')::bigint, 0)
     OR v_promo_adjustment_total <> COALESCE((p_quote->>'promo_discount_halala')::bigint, 0)
     OR v_reward_adjustment_total <> COALESCE((p_quote->>'reward_discount_halala')::bigint, 0)
     OR v_other_discount_total <> COALESCE((p_quote->>'other_discount_halala')::bigint, 0) THEN
    RAISE EXCEPTION 'quote graph components do not match the canonical quote totals'
      USING ERRCODE = '23514';
  END IF;

  RETURN v_quote_id;
END
$function$;

-- Atomically creates the attempt and its complete component graph, then moves
-- the quote to attempted. service_role cannot insert either table directly.
CREATE FUNCTION public.create_payment_attempt(
  p_attempt jsonb,
  p_components jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  quote_row public.checkout_quotes%ROWTYPE;
  existing_row public.payment_attempts%ROWTYPE;
  component_row jsonb;
  v_attempt_id uuid;
  v_quote_id uuid;
  v_merchant_id uuid;
  v_provider text;
  v_tender_type text;
  v_amount_halala bigint;
  v_currency text;
  v_idempotency_key text;
  v_request_fingerprint text;
  v_component_sum bigint := 0;
  v_component_count integer := 0;
  v_component_min integer;
  v_component_max integer;
  v_component_distinct integer;
  v_initial_state text;
BEGIN
  IF jsonb_typeof(p_attempt) <> 'object'
     OR jsonb_typeof(p_components) <> 'array' THEN
    RAISE EXCEPTION 'create_payment_attempt requires an object and component array'
      USING ERRCODE = '22023';
  END IF;

  v_quote_id := (p_attempt->>'quote_id')::uuid;
  v_merchant_id := (p_attempt->>'merchant_id')::uuid;
  v_provider := p_attempt->>'provider';
  v_tender_type := p_attempt->>'tender_type';
  v_amount_halala := (p_attempt->>'amount_halala')::bigint;
  v_currency := COALESCE(NULLIF(p_attempt->>'currency', ''), 'SAR');
  v_idempotency_key := p_attempt->>'idempotency_key';
  v_request_fingerprint := p_attempt->>'request_fingerprint';

  IF v_idempotency_key IS NULL OR v_request_fingerprint IS NULL THEN
    RAISE EXCEPTION 'attempt idempotency key and fingerprint are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_merchant_id::text || ':' || v_idempotency_key, 0)
  );
  SELECT * INTO existing_row
    FROM public.payment_attempts
   WHERE merchant_id = v_merchant_id
     AND idempotency_key = v_idempotency_key;
  IF FOUND THEN
    IF existing_row.request_fingerprint IS DISTINCT FROM v_request_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN existing_row.id;
  END IF;

  SELECT * INTO quote_row
    FROM public.checkout_quotes
   WHERE id = v_quote_id
   FOR UPDATE;
  IF NOT FOUND
     OR quote_row.merchant_id <> v_merchant_id
     OR quote_row.customer_id IS DISTINCT FROM NULLIF(p_attempt->>'customer_id', '')
     OR quote_row.guest_session_id IS DISTINCT FROM NULLIF(p_attempt->>'guest_session_id', '')::uuid
     OR quote_row.total_halala <> v_amount_halala
     OR quote_row.currency <> v_currency THEN
    RAISE EXCEPTION 'payment attempt must exactly bind one quote identity and amount'
      USING ERRCODE = '23514';
  END IF;
  IF quote_row.state NOT IN ('open', 'attempted') OR quote_row.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'payment attempt cannot bind an inactive or expired quote'
      USING ERRCODE = '23514';
  END IF;

  FOR component_row IN SELECT value FROM jsonb_array_elements(p_components)
  LOOP
    IF jsonb_typeof(component_row) <> 'object' THEN
      RAISE EXCEPTION 'attempt component must be an object' USING ERRCODE = '22023';
    END IF;
    v_component_count := v_component_count + 1;
    v_component_sum := v_component_sum + (component_row->>'amount_halala')::bigint;
  END LOOP;
  IF v_component_sum <> v_amount_halala THEN
    RAISE EXCEPTION 'attempt component sum must exactly equal the attempt amount'
      USING ERRCODE = '23514';
  END IF;
  IF v_component_count > 0 THEN
    SELECT
      min((value->>'component_no')::integer),
      max((value->>'component_no')::integer),
      count(DISTINCT (value->>'component_no')::integer)
      INTO v_component_min, v_component_max, v_component_distinct
      FROM jsonb_array_elements(p_components);
    IF v_component_min IS DISTINCT FROM 1
       OR v_component_max IS DISTINCT FROM v_component_count
       OR v_component_distinct IS DISTINCT FROM v_component_count THEN
      RAISE EXCEPTION 'attempt component numbers must be contiguous from one'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_amount_halala = 0 THEN
    IF v_provider <> 'none' OR v_tender_type <> 'none' OR v_component_count <> 0 THEN
      RAISE EXCEPTION 'zero-total settlement requires provider/tender none and no components'
        USING ERRCODE = '23514';
    END IF;
    v_initial_state := 'captured';
  ELSIF v_provider = 'mixed' AND v_tender_type = 'mixed' THEN
    IF v_component_count < 2 THEN
      RAISE EXCEPTION 'mixed payment requires at least two components'
        USING ERRCODE = '23514';
    END IF;
    v_initial_state := 'created';
  ELSE
    IF v_component_count <> 1
       OR (p_components->0->>'tender_type') IS DISTINCT FROM v_tender_type THEN
      RAISE EXCEPTION 'non-mixed payment requires one matching component'
        USING ERRCODE = '23514';
    END IF;
    v_initial_state := CASE WHEN v_provider = 'cash' THEN 'due' ELSE 'created' END;
  END IF;

  IF NOT (
    (v_provider = 'cash' AND v_tender_type = 'cash')
    OR (v_provider = 'moyasar' AND v_tender_type IN ('card', 'apple_pay', 'saved_card'))
    OR (v_provider = 'wallet' AND v_tender_type IN ('wallet', 'cashback'))
    OR (v_provider = 'mixed' AND v_tender_type = 'mixed')
    OR (v_provider = 'none' AND v_tender_type = 'none' AND v_amount_halala = 0)
  ) THEN
    RAISE EXCEPTION 'payment provider and tender type are inconsistent'
      USING ERRCODE = '23514';
  END IF;

  v_attempt_id := COALESCE(NULLIF(p_attempt->>'id', '')::uuid, gen_random_uuid());
  INSERT INTO public.payment_attempts (
    id, quote_id, merchant_id, customer_id, guest_session_id,
    provider, tender_type, amount_halala, currency, state,
    return_url_key, idempotency_key, request_fingerprint, expires_at
  ) VALUES (
    v_attempt_id, v_quote_id, v_merchant_id,
    quote_row.customer_id, quote_row.guest_session_id,
    v_provider, v_tender_type, v_amount_halala, v_currency, v_initial_state,
    p_attempt->>'return_url_key', v_idempotency_key, v_request_fingerprint,
    quote_row.expires_at
  );

  FOR component_row IN SELECT value FROM jsonb_array_elements(p_components)
  LOOP
    INSERT INTO public.payment_attempt_components (
      attempt_id, component_no, tender_type, amount_halala, collection_state
    ) VALUES (
      v_attempt_id,
      (component_row->>'component_no')::integer,
      component_row->>'tender_type',
      (component_row->>'amount_halala')::bigint,
      CASE WHEN component_row->>'tender_type' = 'cash' THEN 'due' ELSE 'pending' END
    );
  END LOOP;

  IF quote_row.state = 'open' THEN
    UPDATE public.checkout_quotes
       SET state = 'attempted',
           version = version + 1,
           attempted_at = clock_timestamp()
     WHERE id = quote_row.id;
  END IF;
  RETURN v_attempt_id;
END
$function$;

-- Materialization is idempotent but never partial: it locks the already-bound
-- order and quote and copies every immutable line/option in one transaction.
CREATE FUNCTION public.materialize_quote_order_lines(
  p_order_id text,
  p_quote_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  order_row public.customer_orders%ROWTYPE;
  quote_row public.checkout_quotes%ROWTYPE;
  v_expected_lines integer;
  v_expected_options integer;
  v_existing_lines integer;
  v_existing_options integer;
BEGIN
  SELECT * INTO order_row
    FROM public.customer_orders
   WHERE id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found for quote materialization' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO quote_row
    FROM public.checkout_quotes
   WHERE id = p_quote_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote not found for order materialization' USING ERRCODE = 'P0002';
  END IF;

  IF order_row.checkout_quote_id IS DISTINCT FROM quote_row.id
     OR order_row.payment_attempt_id IS NULL
     OR order_row.merchant_id IS DISTINCT FROM quote_row.merchant_id::text
     OR order_row.customer_id IS DISTINCT FROM COALESCE(quote_row.customer_id, 'guest')
     OR order_row.branch_id IS DISTINCT FROM quote_row.branch_id::text
     OR order_row.order_type IS DISTINCT FROM quote_row.fulfillment_type
     OR order_row.delivery_latitude IS DISTINCT FROM quote_row.delivery_latitude
     OR order_row.delivery_longitude IS DISTINCT FROM quote_row.delivery_longitude
     OR order_row.delivery_zone_config_hash IS DISTINCT FROM quote_row.delivery_zone_config_hash
     OR order_row.total_halala IS DISTINCT FROM quote_row.total_halala
     OR order_row.currency IS DISTINCT FROM quote_row.currency
     OR quote_row.state NOT IN ('attempted', 'committed') THEN
    RAISE EXCEPTION 'order and quote are not an exact active binding'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_expected_lines
    FROM public.checkout_quote_lines WHERE quote_id = quote_row.id;
  SELECT count(*) INTO v_expected_options
    FROM public.checkout_quote_options AS option_row
    JOIN public.checkout_quote_lines AS line ON line.id = option_row.quote_line_id
   WHERE line.quote_id = quote_row.id;
  SELECT count(*) INTO v_existing_lines
    FROM public.order_lines WHERE order_id = order_row.id;
  SELECT count(*) INTO v_existing_options
    FROM public.order_line_options AS option_row
    JOIN public.order_lines AS line ON line.id = option_row.order_line_id
   WHERE line.order_id = order_row.id;

  IF v_existing_lines <> 0 OR v_existing_options <> 0 THEN
    IF v_existing_lines <> v_expected_lines OR v_existing_options <> v_expected_options
       OR EXISTS (
         SELECT 1
           FROM public.checkout_quote_lines AS source
           LEFT JOIN public.order_lines AS materialized
             ON materialized.checkout_quote_line_id = source.id
            AND materialized.order_id = order_row.id
          WHERE source.quote_id = quote_row.id
            AND (
              materialized.id IS NULL
              OR materialized.checkout_quote_id IS DISTINCT FROM source.quote_id
              OR materialized.merchant_id IS DISTINCT FROM source.merchant_id
              OR materialized.line_no IS DISTINCT FROM source.line_no
              OR materialized.product_id IS DISTINCT FROM source.product_id
              OR materialized.foodics_product_id IS DISTINCT FROM source.foodics_product_id
              OR materialized.product_name IS DISTINCT FROM source.product_name
              OR materialized.quantity IS DISTINCT FROM source.quantity
              OR materialized.base_unit_halala IS DISTINCT FROM source.base_unit_halala
              OR materialized.modifier_unit_halala IS DISTINCT FROM source.modifier_unit_halala
              OR materialized.base_total_halala IS DISTINCT FROM source.base_total_halala
              OR materialized.modifier_total_halala IS DISTINCT FROM source.modifier_total_halala
              OR materialized.tax_halala IS DISTINCT FROM source.tax_halala
              OR materialized.line_subtotal_halala IS DISTINCT FROM source.line_subtotal_halala
              OR materialized.line_discount_halala IS DISTINCT FROM source.line_discount_halala
              OR materialized.line_total_halala IS DISTINCT FROM source.line_total_halala
            )
       )
       OR EXISTS (
         SELECT 1
           FROM public.checkout_quote_options AS source
           JOIN public.checkout_quote_lines AS source_line ON source_line.id = source.quote_line_id
           LEFT JOIN public.order_line_options AS materialized
             ON materialized.checkout_quote_option_id = source.id
           LEFT JOIN public.order_lines AS materialized_line
             ON materialized_line.id = materialized.order_line_id
          WHERE source_line.quote_id = quote_row.id
            AND (
              materialized.id IS NULL
              OR materialized_line.order_id IS DISTINCT FROM order_row.id
              OR materialized.checkout_quote_line_id IS DISTINCT FROM source.quote_line_id
              OR materialized.option_no IS DISTINCT FROM source.option_no
              OR materialized.group_id IS DISTINCT FROM source.group_id
              OR materialized.group_name IS DISTINCT FROM source.group_name
              OR materialized.option_id IS DISTINCT FROM source.option_id
              OR materialized.option_name IS DISTINCT FROM source.option_name
              OR materialized.quantity IS DISTINCT FROM source.quantity
              OR materialized.unit_price_halala IS DISTINCT FROM source.unit_price_halala
              OR materialized.total_halala IS DISTINCT FROM source.total_halala
            )
       ) THEN
      RAISE EXCEPTION 'existing normalized order graph differs from its quote'
        USING ERRCODE = '23514';
    END IF;
    RETURN v_expected_lines;
  END IF;

  INSERT INTO public.order_lines (
    order_id, checkout_quote_id, checkout_quote_line_id, merchant_id,
    line_no, product_id, foodics_product_id, product_name, quantity,
    base_unit_halala, modifier_unit_halala,
    base_total_halala, modifier_total_halala, tax_halala,
    line_subtotal_halala, line_discount_halala, line_total_halala
  )
  SELECT
    order_row.id, source.quote_id, source.id, source.merchant_id,
    source.line_no, source.product_id, source.foodics_product_id, source.product_name, source.quantity,
    source.base_unit_halala, source.modifier_unit_halala,
    source.base_total_halala, source.modifier_total_halala, source.tax_halala,
    source.line_subtotal_halala, source.line_discount_halala, source.line_total_halala
    FROM public.checkout_quote_lines AS source
   WHERE source.quote_id = quote_row.id
   ORDER BY source.line_no;

  INSERT INTO public.order_line_options (
    order_line_id, checkout_quote_line_id, checkout_quote_option_id,
    option_no, group_id, group_name, option_id, option_name,
    quantity, unit_price_halala, total_halala
  )
  SELECT
    materialized_line.id, source.quote_line_id, source.id,
    source.option_no, source.group_id, source.group_name, source.option_id, source.option_name,
    source.quantity, source.unit_price_halala, source.total_halala
    FROM public.checkout_quote_options AS source
    JOIN public.order_lines AS materialized_line
      ON materialized_line.checkout_quote_line_id = source.quote_line_id
     AND materialized_line.order_id = order_row.id
   ORDER BY materialized_line.line_no, source.option_no;

  RETURN v_expected_lines;
END
$function$;

ALTER FUNCTION public.persist_checkout_quote(jsonb, jsonb, jsonb) OWNER TO postgres;
ALTER FUNCTION public.create_payment_attempt(jsonb, jsonb) OWNER TO postgres;
ALTER FUNCTION public.materialize_quote_order_lines(text, uuid) OWNER TO postgres;
ALTER FUNCTION public.touch_promo_codes_updated_at() OWNER TO postgres;
ALTER FUNCTION public.reject_phase_b_immutable_mutation() OWNER TO postgres;
ALTER FUNCTION public.bind_phase_b_provider_object(text, text, text, text, uuid) OWNER TO postgres;
ALTER FUNCTION public.enforce_phase_b_provider_bindings() OWNER TO postgres;
ALTER FUNCTION public.enforce_checkout_quote_transition() OWNER TO postgres;
ALTER FUNCTION public.enforce_payment_attempt_transition() OWNER TO postgres;
ALTER FUNCTION public.enforce_payment_attempt_insert() OWNER TO postgres;
ALTER FUNCTION public.enforce_attempt_component_transition() OWNER TO postgres;
ALTER FUNCTION public.enforce_wallet_topup_transition() OWNER TO postgres;
ALTER FUNCTION public.enforce_quote_backed_order_link() OWNER TO postgres;

ALTER TABLE public.checkout_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkout_quote_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkout_quote_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkout_quote_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_attempt_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_attempt_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_topup_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_object_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_line_options ENABLE ROW LEVEL SECURITY;

-- 2026-07-15 audit fix (F21/companion): RLS was enabled on all 11 tables
-- above with zero CREATE POLICY statements. This project's own established
-- convention (20260709000000_master_audit_remediation.sql) already
-- documents that a policy-less RLS-enabled table silently no-ops
-- service_role reads/writes here. This is more severe than the equivalent
-- Phase C gap: payment_attempts / payment_attempt_components get a direct
-- UPDATE grant below (the webhook capture path) and
-- payment_attempt_observations / wallet_topup_intents get direct INSERT —
-- without a policy, the capture-confirmation pipeline (including the
-- mixed-provider guard fixed above) would silently affect zero rows.
DROP POLICY IF EXISTS "service_role_all" ON public.checkout_quotes;
CREATE POLICY "service_role_all" ON public.checkout_quotes
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.checkout_quote_lines;
CREATE POLICY "service_role_all" ON public.checkout_quote_lines
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.checkout_quote_options;
CREATE POLICY "service_role_all" ON public.checkout_quote_options
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.checkout_quote_adjustments;
CREATE POLICY "service_role_all" ON public.checkout_quote_adjustments
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.payment_attempts;
CREATE POLICY "service_role_all" ON public.payment_attempts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.payment_attempt_components;
CREATE POLICY "service_role_all" ON public.payment_attempt_components
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.payment_attempt_observations;
CREATE POLICY "service_role_all" ON public.payment_attempt_observations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.wallet_topup_intents;
CREATE POLICY "service_role_all" ON public.wallet_topup_intents
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.provider_object_bindings;
CREATE POLICY "service_role_all" ON public.provider_object_bindings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.order_lines;
CREATE POLICY "service_role_all" ON public.order_lines
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.order_line_options;
CREATE POLICY "service_role_all" ON public.order_line_options
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.checkout_quotes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.checkout_quote_lines FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.checkout_quote_options FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.checkout_quote_adjustments FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.payment_attempts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.payment_attempt_components FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.payment_attempt_observations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.wallet_topup_intents FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.provider_object_bindings FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.order_lines FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.order_line_options FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.payment_attempt_observations_id_seq FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.checkout_quotes TO service_role;
GRANT SELECT ON TABLE public.checkout_quote_lines TO service_role;
GRANT SELECT ON TABLE public.checkout_quote_options TO service_role;
GRANT SELECT ON TABLE public.checkout_quote_adjustments TO service_role;
GRANT SELECT, UPDATE ON TABLE public.payment_attempts TO service_role;
GRANT SELECT, UPDATE ON TABLE public.payment_attempt_components TO service_role;
GRANT SELECT, INSERT ON TABLE public.payment_attempt_observations TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.payment_attempt_observations_id_seq TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.wallet_topup_intents TO service_role;
GRANT SELECT ON TABLE public.provider_object_bindings TO service_role;
GRANT SELECT ON TABLE public.order_lines TO service_role;
GRANT SELECT ON TABLE public.order_line_options TO service_role;

REVOKE ALL ON FUNCTION public.persist_checkout_quote(jsonb, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.persist_checkout_quote(jsonb, jsonb, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.create_payment_attempt(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_payment_attempt(jsonb, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.materialize_quote_order_lines(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.materialize_quote_order_lines(text, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.touch_promo_codes_updated_at()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reject_phase_b_immutable_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bind_phase_b_provider_object(text, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_phase_b_provider_bindings()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_checkout_quote_transition()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_payment_attempt_transition()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_payment_attempt_insert()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_attempt_component_transition()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_wallet_topup_transition()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_quote_backed_order_link()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.checkout_quotes IS
  'Immutable server-priced checkout authorization snapshot. Client economic fields are never authoritative.';
COMMENT ON TABLE public.payment_attempts IS
  'Durable exact-amount payment attempt created before any provider mutation.';
COMMENT ON TABLE public.payment_attempt_observations IS
  'Append-only provider observations. Stores hashes and canonical fields, not raw sensitive payloads.';
COMMENT ON TABLE public.order_lines IS
  'Canonical normalized order economics materialized from a quote; customer_orders.items is legacy display data only.';
COMMENT ON FUNCTION public.persist_checkout_quote(jsonb, jsonb, jsonb) IS
  'Service-only atomic and idempotent persistence for an already server-priced immutable quote graph.';
COMMENT ON FUNCTION public.create_payment_attempt(jsonb, jsonb) IS
  'Service-only atomic attempt/component creation with exact quote binding and one active attempt per quote.';
COMMENT ON FUNCTION public.materialize_quote_order_lines(text, uuid) IS
  'Service-only idempotent copy of the complete immutable quote graph into normalized order economics.';
COMMENT ON TABLE public.provider_object_bindings IS
  'Trigger-owned cross-domain registry preventing provider payment/invoice id reuse.';

DO $phase_b_postconditions$
DECLARE
  expected_table_name text;
  function_signature text;
  function_oid oid;
BEGIN
  FOREACH expected_table_name IN ARRAY ARRAY[
    'checkout_quotes', 'checkout_quote_lines', 'checkout_quote_options',
    'checkout_quote_adjustments', 'payment_attempts', 'payment_attempt_components',
    'payment_attempt_observations', 'wallet_topup_intents', 'provider_object_bindings', 'order_lines',
    'order_line_options'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS c
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = expected_table_name
         AND c.relkind IN ('r', 'p')
         AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'Phase B postcondition: public.% missing or RLS disabled', expected_table_name;
    END IF;
  END LOOP;

  FOREACH function_signature IN ARRAY ARRAY[
    'public.persist_checkout_quote(jsonb,jsonb,jsonb)',
    'public.create_payment_attempt(jsonb,jsonb)',
    'public.materialize_quote_order_lines(text,uuid)'
  ]
  LOOP
    function_oid := pg_catalog.to_regprocedure(function_signature);
    IF function_oid IS NULL
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.pg_proc AS p,
                LATERAL pg_catalog.aclexplode(
                  COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
                ) AS acl
          WHERE p.oid = function_oid
            AND acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Phase B postcondition: RPC ACL is not service-role-only for %', function_signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('checkout_quotes'), ('checkout_quote_lines'), ('checkout_quote_options'),
        ('checkout_quote_adjustments'), ('payment_attempts'), ('payment_attempt_components'),
        ('payment_attempt_observations'), ('wallet_topup_intents'), ('provider_object_bindings'), ('order_lines'),
        ('order_line_options')
      ) AS expected(name)
     WHERE pg_catalog.has_table_privilege('anon', 'public.' || expected.name, 'INSERT,UPDATE,DELETE')
        OR pg_catalog.has_table_privilege('authenticated', 'public.' || expected.name, 'INSERT,UPDATE,DELETE')
  ) THEN
    RAISE EXCEPTION 'Phase B postcondition: untrusted role retains an economic table write privilege';
  END IF;

  IF pg_catalog.has_table_privilege('service_role', 'public.payment_attempts', 'INSERT')
     OR pg_catalog.has_table_privilege('service_role', 'public.payment_attempt_components', 'INSERT')
     OR NOT EXISTS (
       SELECT 1
         FROM information_schema.columns AS cols
        WHERE cols.table_schema = 'public'
          AND cols.table_name = 'promo_codes'
          AND cols.column_name = 'updated_at'
          AND cols.is_nullable = 'NO'
          AND cols.column_default = 'clock_timestamp()'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public' AND indexname = 'payment_attempts_one_active_per_quote'
     ) THEN
    RAISE EXCEPTION 'Phase B postcondition: atomic attempt or promo version foundation drift';
  END IF;
END
$phase_b_postconditions$;

COMMIT;
