-- Phase D: reversal saga. Durable, idempotent, service-only reversal ledger
-- for cancelled / refused / refunded / complained orders across every value
-- rail (card via Moyasar, wallet, cashback, loyalty rewards, promo, earned
-- loyalty clawback, commission, POS/Foodics void).
--
-- IMPORTANT:
--   * Single migration source for the shared Frankfurt production database.
--   * Additive only. Every economic/worker control defaults OFF. No provider
--     (Moyasar / Foodics) HTTP is performed by this migration or its tests.
--   * The legacy public.order_reversals table (a flat per-order summary) is
--     preserved untouched as a compatibility projection target; its historical
--     rows are never rewritten and it is never read as authority.
--   * Design reviewed 2026-07-15. Conservation is enforced by a per-(order,rail)
--     budget accumulator + CHECK (READ COMMITTED safe), NOT a trigger-SUM.
--     unknown / processing / manual_review all HOLD reserved budget until a
--     provider read-back proves release. Per-rail budgets make alternate-rail
--     compensation mechanically impossible.
--   * service_role on Frankfurt has BYPASSRLS; table GRANTs are the load-bearing
--     authority. The service_role FOR ALL policies below are belt-and-suspenders
--     matching house convention (protect if BYPASSRLS is ever revoked).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '120s';

-- ─────────────────────────────────────────────────────────────────────────
-- Preflight: verify the environment we depend on and refuse partial drift.
-- ─────────────────────────────────────────────────────────────────────────
DO $phase_d_preflight$
DECLARE
  required_table text;
  new_table text;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'merchants', 'customer_orders', 'order_reversals',
    'payment_attempts', 'payment_attempt_components', 'payment_attempt_observations',
    'provider_object_bindings'
  ]
  LOOP
    IF pg_catalog.to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION 'Phase D preflight: missing prerequisite public.% (apply Phase B first)', required_table;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'Phase D preflight: expected Supabase API roles are missing';
  END IF;

  -- The two Phase B constraints we widen additively must exist as expected.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_object_bindings'::regclass
       AND conname = 'provider_object_bindings_kind_valid'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.provider_object_bindings'::regclass
       AND conname = 'provider_object_bindings_domain_valid'
  ) THEN
    RAISE EXCEPTION 'Phase D preflight: provider_object_bindings constraints not in the expected Phase B shape';
  END IF;

  FOREACH new_table IN ARRAY ARRAY[
    'phase_d_runtime_controls', 'order_reversal_commands', 'order_reversal_basis',
    'order_reversal_components', 'order_reversal_observations'
  ]
  LOOP
    IF pg_catalog.to_regclass('public.' || new_table) IS NOT NULL THEN
      RAISE EXCEPTION 'Phase D preflight: partial/drifted object public.% already exists', new_table;
    END IF;
  END LOOP;
END
$phase_d_preflight$;

-- ─────────────────────────────────────────────────────────────────────────
-- Runtime controls (singleton). Everything OFF. Provider-write gates are
-- separate from the local-rail gate so wallet credit-back can be enabled long
-- before automated card refunds are trusted.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE public.phase_d_runtime_controls (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  reversal_commands_enabled boolean NOT NULL DEFAULT false,
  local_rail_worker_enabled boolean NOT NULL DEFAULT false,
  moyasar_refund_writes_enabled boolean NOT NULL DEFAULT false,
  foodics_void_writes_enabled boolean NOT NULL DEFAULT false,
  legacy_projection_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL DEFAULT 'migration'
);
INSERT INTO public.phase_d_runtime_controls (singleton) VALUES (true);

-- ─────────────────────────────────────────────────────────────────────────
-- Commands: one logical reversal request.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE public.order_reversal_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  order_id text NOT NULL,
  command_kind text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  plan jsonb NOT NULL,
  plan_sha256 text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  requested_total_halala bigint NOT NULL DEFAULT 0,
  settled_total_halala bigint NOT NULL DEFAULT 0,
  initiator_type text NOT NULL,
  initiator_id text,
  source_channel text,
  version bigint NOT NULL DEFAULT 0,
  last_error_code text,
  superseded_by uuid REFERENCES public.order_reversal_commands(id) ON DELETE RESTRICT,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_reversal_commands_order_nonempty CHECK (btrim(order_id) <> ''),
  CONSTRAINT order_reversal_commands_key_nonempty CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT order_reversal_commands_fingerprint_nonempty CHECK (btrim(request_fingerprint) <> ''),
  CONSTRAINT order_reversal_commands_plan_sha_nonempty CHECK (btrim(plan_sha256) <> ''),
  CONSTRAINT order_reversal_commands_amounts_nonneg CHECK (
    requested_total_halala >= 0 AND settled_total_halala >= 0
  ),
  CONSTRAINT order_reversal_commands_kind_valid CHECK (
    command_kind IN ('full_cancel', 'partial_refund', 'pos_cancel', 'complaint', 'manual_refund', 'relay_failure')
  ),
  CONSTRAINT order_reversal_commands_initiator_valid CHECK (
    initiator_type IN ('customer', 'merchant', 'system', 'operator')
  ),
  CONSTRAINT order_reversal_commands_state_valid CHECK (
    state IN ('pending', 'processing', 'succeeded', 'completed_with_abandonments', 'failed', 'unknown', 'manual_review')
  ),
  CONSTRAINT order_reversal_commands_identity_unique UNIQUE (merchant_id, idempotency_key)
);

-- Only one non-terminal full_cancel per order; converging entry points must
-- coalesce onto one command rather than spawning duplicates the budget would
-- then half-strangle. Partial refunds have no such restriction.
CREATE UNIQUE INDEX order_reversal_commands_one_active_full_cancel
  ON public.order_reversal_commands (order_id)
  WHERE command_kind = 'full_cancel'
    AND state IN ('pending', 'processing', 'unknown', 'manual_review');

CREATE INDEX order_reversal_commands_order_idx
  ON public.order_reversal_commands (order_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Basis (KEYSTONE): per-(order, rail) frozen refund budget. captured_basis is
-- write-once and server-derived. reserved+settled can never exceed it — the
-- conservation invariant lives here as an atomic CHECK, not a racy SUM.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE public.order_reversal_basis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL,
  rail text NOT NULL,
  captured_basis_halala bigint NOT NULL,
  reversal_reserved_halala bigint NOT NULL DEFAULT 0,
  reversal_settled_halala bigint NOT NULL DEFAULT 0,
  basis_source text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_reversal_basis_order_nonempty CHECK (btrim(order_id) <> ''),
  CONSTRAINT order_reversal_basis_rail_valid CHECK (
    rail IN ('card', 'wallet', 'cashback', 'loyalty_reward', 'promo', 'loyalty_earn_clawback', 'commission', 'pos_foodics')
  ),
  CONSTRAINT order_reversal_basis_source_valid CHECK (
    basis_source IN ('payment_attempt_component', 'legacy_derived')
  ),
  CONSTRAINT order_reversal_basis_captured_nonneg CHECK (captured_basis_halala >= 0),
  CONSTRAINT order_reversal_basis_accum_nonneg CHECK (
    reversal_reserved_halala >= 0 AND reversal_settled_halala >= 0
  ),
  -- The conservation invariant. Atomic under READ COMMITTED because the row
  -- lock serializes concurrent accumulator UPDATEs and the CHECK re-evaluates
  -- against the committed tuple.
  CONSTRAINT order_reversal_basis_budget_conserved CHECK (
    reversal_settled_halala + reversal_reserved_halala <= captured_basis_halala
  ),
  CONSTRAINT order_reversal_basis_evidence_sha_nonempty CHECK (btrim(evidence_sha256) <> ''),
  CONSTRAINT order_reversal_basis_order_rail_unique UNIQUE (order_id, rail)
);

CREATE INDEX order_reversal_basis_order_idx
  ON public.order_reversal_basis (order_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Components: per-rail work item = the claim row. External rails (card/pos)
-- carry lease + read-back machinery; local rails settle atomically.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE public.order_reversal_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id uuid NOT NULL REFERENCES public.order_reversal_commands(id) ON DELETE RESTRICT,
  basis_id uuid NOT NULL REFERENCES public.order_reversal_basis(id) ON DELETE RESTRICT,
  order_id text NOT NULL,
  rail text NOT NULL,
  component_no integer NOT NULL,
  amount_halala bigint NOT NULL,
  is_external boolean NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  execution_stage integer NOT NULL DEFAULT 100,
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_retry_at timestamptz,
  lease_token uuid,
  leased_until timestamptz,
  leased_by text,
  claimed_at timestamptz,
  provider text,
  provider_payment_id text,
  provider_refund_id text,
  refunded_before_halala bigint,
  last_error_code text,
  abandoned_reason text,
  abandoned_by text,
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_reversal_components_no_positive CHECK (component_no >= 1),
  CONSTRAINT order_reversal_components_amount_positive CHECK (amount_halala > 0),
  CONSTRAINT order_reversal_components_rail_valid CHECK (
    rail IN ('card', 'wallet', 'cashback', 'loyalty_reward', 'promo', 'loyalty_earn_clawback', 'commission', 'pos_foodics')
  ),
  CONSTRAINT order_reversal_components_state_valid CHECK (
    state IN ('pending', 'processing', 'succeeded', 'failed', 'unknown', 'manual_review', 'abandoned', 'retry', 'dead_letter')
  ),
  -- Only external rails may carry a provider binding; local rails never do.
  CONSTRAINT order_reversal_components_external_provider CHECK (
    is_external OR (provider IS NULL AND provider_payment_id IS NULL AND provider_refund_id IS NULL)
  ),
  CONSTRAINT order_reversal_components_command_no_unique UNIQUE (command_id, component_no)
);

-- Claim index: workers pull ready rows with FOR UPDATE SKIP LOCKED.
CREATE INDEX order_reversal_components_claimable
  ON public.order_reversal_components (available_at, id)
  WHERE state IN ('pending', 'retry');

-- Single execution slot per Moyasar payment id while a card refund is in
-- flight or unresolved. This is what prevents a lease-steal double-refund.
CREATE UNIQUE INDEX order_reversal_components_one_active_card
  ON public.order_reversal_components (provider_payment_id)
  WHERE rail = 'card'
    AND provider_payment_id IS NOT NULL
    AND state IN ('processing', 'unknown', 'manual_review');

CREATE INDEX order_reversal_components_command_idx
  ON public.order_reversal_components (command_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Observations: append-only, service-INSERT-only evidence of provider / POS /
-- local effects. Immutable once written.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE public.order_reversal_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  component_id uuid REFERENCES public.order_reversal_components(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL REFERENCES public.order_reversal_commands(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  provider text,
  provider_object_id text,
  provider_event_id text,
  observed_amount_halala bigint,
  observed_currency text,
  payload_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_reversal_observations_kind_valid CHECK (
    kind IN ('write_intent', 'api_response', 'webhook', 'readback', 'provider_rejected',
             'readback_no_effect', 'readback_confirmed', 'manual_attestation', 'local_effect')
  ),
  CONSTRAINT order_reversal_observations_amount_nonneg CHECK (
    observed_amount_halala IS NULL OR observed_amount_halala >= 0
  ),
  CONSTRAINT order_reversal_observations_currency_valid CHECK (
    observed_currency IS NULL OR observed_currency = 'SAR'
  ),
  CONSTRAINT order_reversal_observations_payload_nonempty CHECK (btrim(payload_sha256) <> '')
);

-- Provider events dedupe harmlessly (webhook vs resolver read-back race).
CREATE UNIQUE INDEX order_reversal_observations_provider_event_unique
  ON public.order_reversal_observations (provider, provider_event_id)
  WHERE provider IS NOT NULL AND provider_event_id IS NOT NULL;

CREATE INDEX order_reversal_observations_component_idx
  ON public.order_reversal_observations (component_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Additively widen the Phase B provider-object registry to own refund objects
-- from reversal components (global uniqueness across economic domains).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.provider_object_bindings
  DROP CONSTRAINT provider_object_bindings_kind_valid;
ALTER TABLE public.provider_object_bindings
  ADD CONSTRAINT provider_object_bindings_kind_valid
  CHECK (object_kind IN ('payment', 'invoice', 'refund'));

ALTER TABLE public.provider_object_bindings
  DROP CONSTRAINT provider_object_bindings_domain_valid;
ALTER TABLE public.provider_object_bindings
  ADD CONSTRAINT provider_object_bindings_domain_valid
  CHECK (source_domain IN ('payment_attempt', 'wallet_topup', 'order_reversal_component'));

-- ═════════════════════════════════════════════════════════════════════════
-- Trigger functions
-- ═════════════════════════════════════════════════════════════════════════

-- Runtime-control gate helper (service-only; used by RPCs).
CREATE FUNCTION public.phase_d_require_control(p_control text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_enabled boolean;
BEGIN
  EXECUTE pg_catalog.format(
    'SELECT %I FROM public.phase_d_runtime_controls WHERE singleton',
    p_control
  ) INTO v_enabled;
  IF v_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Phase D control % is disabled', p_control USING ERRCODE = '0A000';
  END IF;
END
$function$;

-- Runtime controls: immutable except the flags + audit columns.
CREATE FUNCTION public.enforce_phase_d_controls_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'phase_d_runtime_controls is a singleton and may not be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.singleton IS DISTINCT FROM OLD.singleton THEN
    RAISE EXCEPTION 'phase_d_runtime_controls singleton is immutable' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE TRIGGER phase_d_runtime_controls_guard
BEFORE UPDATE OR DELETE ON public.phase_d_runtime_controls
FOR EACH ROW EXECUTE FUNCTION public.enforce_phase_d_controls_mutation();

-- Basis: captured_basis / source / evidence are write-once; only the two
-- accumulator columns and updated_at may change (and only via the component
-- trigger, which holds the row lock).
CREATE FUNCTION public.enforce_reversal_basis_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order_reversal_basis rows are durable and may not be deleted' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['reversal_reserved_halala', 'reversal_settled_halala', 'updated_at'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['reversal_reserved_halala', 'reversal_settled_halala', 'updated_at']) THEN
    RAISE EXCEPTION 'order_reversal_basis captured amount, source, and evidence are immutable' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE TRIGGER order_reversal_basis_guard
BEFORE UPDATE OR DELETE ON public.order_reversal_basis
FOR EACH ROW EXECUTE FUNCTION public.enforce_reversal_basis_mutation();

-- Observations are append-only.
CREATE FUNCTION public.reject_reversal_observation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'order_reversal_observations are append-only' USING ERRCODE = '55000';
END
$function$;

CREATE TRIGGER order_reversal_observations_immutable
BEFORE UPDATE OR DELETE ON public.order_reversal_observations
FOR EACH ROW EXECUTE FUNCTION public.reject_reversal_observation_mutation();

-- Command transition guard + terminality invariant.
CREATE FUNCTION public.enforce_reversal_command_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order_reversal_commands are durable and may not be deleted' USING ERRCODE = '55000';
  END IF;
  -- Economics and identity are immutable; only progress columns may move.
  IF (to_jsonb(NEW) - ARRAY[
        'state', 'version', 'settled_total_halala', 'last_error_code',
        'superseded_by', 'completed_at', 'updated_at'
      ]) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'state', 'version', 'settled_total_halala', 'last_error_code',
        'superseded_by', 'completed_at', 'updated_at'
      ]) THEN
    RAISE EXCEPTION 'order reversal command economics and identity are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'reversal command transition requires version + 1' USING ERRCODE = '40001';
  END IF;
  -- A same-state update (e.g. the component trigger rolling up settled_total)
  -- is allowed; only cross-state moves are constrained to the legal set.
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'pending' AND NEW.state IN ('processing', 'failed', 'manual_review'))
    OR (OLD.state = 'processing' AND NEW.state IN ('succeeded', 'completed_with_abandonments', 'failed', 'unknown', 'manual_review'))
    OR (OLD.state = 'unknown' AND NEW.state IN ('processing', 'succeeded', 'completed_with_abandonments', 'failed', 'manual_review'))
    OR (OLD.state = 'manual_review' AND NEW.state IN ('processing', 'succeeded', 'completed_with_abandonments', 'failed'))
  ) THEN
    RAISE EXCEPTION 'illegal reversal command transition: % -> %', OLD.state, NEW.state USING ERRCODE = '22023';
  END IF;

  -- Terminality: a command may only be 'succeeded' when every component is a
  -- terminal success; 'completed_with_abandonments' requires at least one
  -- abandoned component and no unfinished siblings.
  IF NEW.state IN ('succeeded', 'completed_with_abandonments') THEN
    IF EXISTS (
      SELECT 1 FROM public.order_reversal_components AS c
       WHERE c.command_id = NEW.id
         AND c.state NOT IN ('succeeded', 'abandoned')
    ) THEN
      RAISE EXCEPTION 'reversal command cannot complete while components are unfinished' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF NEW.state = 'succeeded' THEN
    IF EXISTS (
      SELECT 1 FROM public.order_reversal_components AS c
       WHERE c.command_id = NEW.id AND c.state = 'abandoned'
    ) THEN
      RAISE EXCEPTION 'reversal command with abandoned components must use completed_with_abandonments'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  IF NEW.state = 'completed_with_abandonments' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.order_reversal_components AS c
       WHERE c.command_id = NEW.id AND c.state = 'abandoned'
    ) THEN
      RAISE EXCEPTION 'completed_with_abandonments requires at least one abandoned component'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NEW.state IN ('succeeded', 'completed_with_abandonments', 'failed') AND NEW.completed_at IS NULL THEN
    NEW.completed_at := clock_timestamp();
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE TRIGGER order_reversal_commands_guard
BEFORE UPDATE OR DELETE ON public.order_reversal_commands
FOR EACH ROW EXECUTE FUNCTION public.enforce_reversal_command_transition();

-- Component transition guard + budget accumulator (the conservation engine).
CREATE FUNCTION public.enforce_reversal_component_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_reserve_delta bigint := 0;
  v_settle_delta bigint := 0;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order_reversal_components are durable and may not be deleted' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A new component immediately reserves its amount against the rail budget.
    UPDATE public.order_reversal_basis
       SET reversal_reserved_halala = reversal_reserved_halala + NEW.amount_halala
     WHERE id = NEW.basis_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reversal component references a missing basis row' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE path.
  -- Economics / identity / provider-request material are write-once.
  IF (to_jsonb(NEW) - ARRAY[
        'state', 'version', 'attempt_count', 'available_at', 'next_retry_at',
        'lease_token', 'leased_until', 'leased_by', 'claimed_at',
        'provider', 'provider_payment_id', 'provider_refund_id', 'refunded_before_halala',
        'last_error_code', 'abandoned_reason', 'abandoned_by', 'updated_at'
      ]) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'state', 'version', 'attempt_count', 'available_at', 'next_retry_at',
        'lease_token', 'leased_until', 'leased_by', 'claimed_at',
        'provider', 'provider_payment_id', 'provider_refund_id', 'refunded_before_halala',
        'last_error_code', 'abandoned_reason', 'abandoned_by', 'updated_at'
      ]) THEN
    RAISE EXCEPTION 'reversal component economics and identity are immutable' USING ERRCODE = '55000';
  END IF;

  -- Write-once provider-request material (defeats read-back attribution if regenerated).
  IF OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
    RAISE EXCEPTION 'component provider_payment_id is write-once' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id THEN
    RAISE EXCEPTION 'component provider_refund_id is write-once' USING ERRCODE = '55000';
  END IF;
  IF OLD.refunded_before_halala IS NOT NULL AND NEW.refunded_before_halala IS DISTINCT FROM OLD.refunded_before_halala THEN
    RAISE EXCEPTION 'component refunded_before_halala snapshot is write-once' USING ERRCODE = '55000';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'reversal component transition requires version + 1' USING ERRCODE = '40001';
  END IF;

  -- A same-state update (lease renewal, attempt_count bump, retry scheduling)
  -- is allowed; only cross-state moves are constrained to the legal set.
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'pending' AND NEW.state IN ('processing', 'succeeded', 'failed', 'unknown', 'manual_review', 'abandoned', 'retry'))
    OR (OLD.state = 'retry' AND NEW.state IN ('processing', 'succeeded', 'failed', 'unknown', 'manual_review', 'abandoned', 'dead_letter'))
    OR (OLD.state = 'processing' AND NEW.state IN ('succeeded', 'failed', 'unknown', 'manual_review', 'retry'))
    OR (OLD.state = 'unknown' AND NEW.state IN ('processing', 'succeeded', 'failed', 'manual_review', 'retry'))
    OR (OLD.state = 'manual_review' AND NEW.state IN ('succeeded', 'failed', 'abandoned'))
  ) THEN
    RAISE EXCEPTION 'illegal reversal component transition: % -> %', OLD.state, NEW.state USING ERRCODE = '22023';
  END IF;

  -- Budget accounting. reserved is held through pending/processing/unknown/
  -- manual_review/retry; released only on a proven terminal outcome. Guard
  -- against double-applying if state does not actually change.
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state = 'succeeded' THEN
      -- Success requires a proving observation (external rails: read-back/
      -- webhook; local rails: local_effect).
      IF NOT EXISTS (
        SELECT 1 FROM public.order_reversal_observations AS o
         WHERE o.component_id = NEW.id
           AND o.kind IN ('readback_confirmed', 'webhook', 'local_effect')
           AND (o.observed_amount_halala IS NULL OR o.observed_amount_halala = NEW.amount_halala)
      ) THEN
        RAISE EXCEPTION 'reversal component cannot succeed without a proving effect observation'
          USING ERRCODE = '23514';
      END IF;
      v_reserve_delta := -NEW.amount_halala;
      v_settle_delta := NEW.amount_halala;
    ELSIF NEW.state = 'failed' THEN
      -- Failure requires a deterministic negative proof; ambiguity must go to
      -- unknown, never failed (invariant #4).
      IF NEW.is_external AND NOT EXISTS (
        SELECT 1 FROM public.order_reversal_observations AS o
         WHERE o.component_id = NEW.id
           AND o.kind IN ('provider_rejected', 'readback_no_effect')
      ) THEN
        RAISE EXCEPTION 'external reversal component cannot fail without a deterministic negative observation'
          USING ERRCODE = '23514';
      END IF;
      v_reserve_delta := -NEW.amount_halala;
    ELSIF NEW.state = 'abandoned' THEN
      v_reserve_delta := -NEW.amount_halala;
      IF NEW.abandoned_reason IS NULL OR btrim(NEW.abandoned_reason) = '' THEN
        RAISE EXCEPTION 'abandoned reversal component requires an abandoned_reason' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.state = 'dead_letter' THEN
      -- dead_letter keeps reserved budget: the effect may still have happened.
      v_reserve_delta := 0;
    ELSE
      -- processing / unknown / manual_review / retry: budget stays reserved.
      v_reserve_delta := 0;
    END IF;

    IF v_reserve_delta <> 0 OR v_settle_delta <> 0 THEN
      UPDATE public.order_reversal_basis
         SET reversal_reserved_halala = reversal_reserved_halala + v_reserve_delta,
             reversal_settled_halala = reversal_settled_halala + v_settle_delta
       WHERE id = NEW.basis_id;
      -- Roll the settled amount up onto the command.
      IF v_settle_delta <> 0 THEN
        UPDATE public.order_reversal_commands
           SET settled_total_halala = settled_total_halala + v_settle_delta,
               version = version + 1
         WHERE id = NEW.command_id;
      END IF;
    END IF;
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE TRIGGER order_reversal_components_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.order_reversal_components
FOR EACH ROW EXECUTE FUNCTION public.enforce_reversal_component_transition();

-- ═════════════════════════════════════════════════════════════════════════
-- Value conservation audit function (mirrors phase_c_value_conservation).
-- ═════════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.phase_d_value_conservation()
RETURNS TABLE (
  order_id text,
  rail text,
  captured_basis_halala bigint,
  reserved_halala bigint,
  settled_halala bigint,
  component_reserved_halala bigint,
  component_settled_halala bigint,
  conservation_ok boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    b.order_id,
    b.rail,
    b.captured_basis_halala,
    b.reversal_reserved_halala,
    b.reversal_settled_halala,
    COALESCE(agg.reserved, 0) AS component_reserved_halala,
    COALESCE(agg.settled, 0) AS component_settled_halala,
    (b.reversal_settled_halala + b.reversal_reserved_halala <= b.captured_basis_halala)
      AND b.reversal_reserved_halala = COALESCE(agg.reserved, 0)
      AND b.reversal_settled_halala = COALESCE(agg.settled, 0)
      AS conservation_ok
  FROM public.order_reversal_basis AS b
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(sum(c.amount_halala) FILTER (
        WHERE c.state IN ('pending', 'processing', 'unknown', 'manual_review', 'retry', 'dead_letter')
      ), 0) AS reserved,
      COALESCE(sum(c.amount_halala) FILTER (WHERE c.state = 'succeeded'), 0) AS settled
      FROM public.order_reversal_components AS c
     WHERE c.basis_id = b.id
  ) AS agg ON true;
$function$;

-- ═════════════════════════════════════════════════════════════════════════
-- Service-only write API (SECURITY DEFINER, owned by the migration role). All
-- table writes flow through these; service_role holds only SELECT on the
-- tables. Provider HTTP is the disabled worker's job — these manage state only.
-- ═════════════════════════════════════════════════════════════════════════

-- Open (or idempotently return) a reversal command with its basis + component
-- plan. The caller derives basis (captured amount + evidence) server-side from
-- Phase B captured components or legacy provider/ledger evidence, and computes
-- the sha256 fingerprints; this RPC validates + persists atomically. The
-- per-rail budget CHECK rejects any plan amount exceeding the captured basis.
CREATE FUNCTION public.open_reversal_command(
  p_merchant_id uuid,
  p_order_id text,
  p_command_kind text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_initiator_type text,
  p_initiator_id text,
  p_source_channel text,
  p_plan_sha256 text,
  p_basis jsonb,
  p_components jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_existing_id uuid;
  v_existing_fingerprint text;
  v_command_id uuid;
  v_basis jsonb;
  v_component jsonb;
  v_basis_id uuid;
  v_requested bigint := 0;
  v_component_no integer := 0;
BEGIN
  PERFORM public.phase_d_require_control('reversal_commands_enabled');

  IF p_basis IS NULL OR pg_catalog.jsonb_typeof(p_basis) <> 'array'
     OR pg_catalog.jsonb_array_length(p_basis) = 0 THEN
    RAISE EXCEPTION 'reversal command requires at least one basis rail' USING ERRCODE = '22023';
  END IF;
  IF p_components IS NULL OR pg_catalog.jsonb_typeof(p_components) <> 'array'
     OR pg_catalog.jsonb_array_length(p_components) = 0 THEN
    RAISE EXCEPTION 'reversal command requires at least one component' USING ERRCODE = '22023';
  END IF;

  -- Serialize the absent-row case; the unique constraint is final authority.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('phase_d:' || p_merchant_id::text || ':' || p_idempotency_key, 0)
  );

  SELECT id, request_fingerprint INTO v_existing_id, v_existing_fingerprint
    FROM public.order_reversal_commands
   WHERE merchant_id = p_merchant_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing_id;
  END IF;

  -- requested_total is write-once, so compute it from the plan up front.
  SELECT COALESCE(sum((value->>'amount_halala')::bigint), 0)
    INTO v_requested
    FROM pg_catalog.jsonb_array_elements(p_components);

  INSERT INTO public.order_reversal_commands (
    merchant_id, order_id, command_kind, idempotency_key, request_fingerprint,
    plan, plan_sha256, requested_total_halala, initiator_type, initiator_id, source_channel
  ) VALUES (
    p_merchant_id, p_order_id, p_command_kind, p_idempotency_key, p_request_fingerprint,
    p_components, p_plan_sha256, v_requested, p_initiator_type, p_initiator_id, p_source_channel
  ) RETURNING id INTO v_command_id;

  -- Basis rows are shared across commands on the same order; create-if-absent
  -- and verify the captured amount is consistent (never silently re-open it).
  FOR v_basis IN SELECT value FROM pg_catalog.jsonb_array_elements(p_basis)
  LOOP
    INSERT INTO public.order_reversal_basis (
      order_id, rail, captured_basis_halala, basis_source, evidence, evidence_sha256
    ) VALUES (
      p_order_id,
      v_basis->>'rail',
      (v_basis->>'captured_basis_halala')::bigint,
      v_basis->>'basis_source',
      COALESCE(v_basis->'evidence', '{}'::jsonb),
      v_basis->>'evidence_sha256'
    )
    ON CONFLICT (order_id, rail) DO NOTHING;

    IF EXISTS (
      SELECT 1 FROM public.order_reversal_basis
       WHERE order_id = p_order_id AND rail = v_basis->>'rail'
         AND captured_basis_halala IS DISTINCT FROM (v_basis->>'captured_basis_halala')::bigint
    ) THEN
      RAISE EXCEPTION 'basis captured amount for rail % conflicts with an existing basis row', v_basis->>'rail'
        USING ERRCODE = '23505';
    END IF;
  END LOOP;

  -- Components reserve their budget on insert (trigger); the CHECK on the basis
  -- row rejects any plan that would exceed the captured amount for that rail.
  FOR v_component IN SELECT value FROM pg_catalog.jsonb_array_elements(p_components)
  LOOP
    v_component_no := v_component_no + 1;
    SELECT id INTO v_basis_id FROM public.order_reversal_basis
     WHERE order_id = p_order_id AND rail = v_component->>'rail';
    IF v_basis_id IS NULL THEN
      RAISE EXCEPTION 'component rail % has no basis row', v_component->>'rail' USING ERRCODE = '23503';
    END IF;

    INSERT INTO public.order_reversal_components (
      command_id, basis_id, order_id, rail, component_no, amount_halala,
      is_external, execution_stage, provider, provider_payment_id
    ) VALUES (
      v_command_id, v_basis_id, p_order_id, v_component->>'rail', v_component_no,
      (v_component->>'amount_halala')::bigint,
      COALESCE((v_component->>'is_external')::boolean, false),
      COALESCE((v_component->>'execution_stage')::integer, 100),
      v_component->>'provider',
      v_component->>'provider_payment_id'
    );
  END LOOP;

  RETURN v_command_id;
END
$function$;

-- Claim a component for work: lease it and move it to processing. Uses the
-- caller-supplied lease window; the single-active-card unique index prevents a
-- second in-flight card refund on the same provider payment id.
CREATE FUNCTION public.claim_reversal_component(
  p_component_id uuid,
  p_leased_by text,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_command_id uuid;
  v_state text;
  v_is_external boolean;
BEGIN
  -- Lock the parent command first (command -> component lock order).
  SELECT c.command_id, c.state, c.is_external
    INTO v_command_id, v_state, v_is_external
    FROM public.order_reversal_components AS c
   WHERE c.id = p_component_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reversal component % not found', p_component_id USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.order_reversal_commands WHERE id = v_command_id FOR UPDATE;

  IF v_state NOT IN ('pending', 'retry') THEN
    RETURN false;
  END IF;

  UPDATE public.order_reversal_components
     SET state = 'processing',
         lease_token = gen_random_uuid(),
         leased_by = p_leased_by,
         leased_until = clock_timestamp() + make_interval(secs => GREATEST(1, p_lease_seconds)),
         claimed_at = clock_timestamp(),
         attempt_count = attempt_count + 1,
         version = version + 1
   WHERE id = p_component_id;
  RETURN true;
END
$function$;

-- Record a local (non-provider) rail effect and settle it atomically. Local
-- rails never enter unknown: the ledger write + settle happen in one txn.
CREATE FUNCTION public.record_reversal_local_effect(
  p_component_id uuid,
  p_payload_sha256 text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_command_id uuid;
  v_amount bigint;
  v_is_external boolean;
  v_state text;
BEGIN
  SELECT command_id, amount_halala, is_external, state
    INTO v_command_id, v_amount, v_is_external, v_state
    FROM public.order_reversal_components
   WHERE id = p_component_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reversal component % not found', p_component_id USING ERRCODE = 'P0002';
  END IF;
  IF v_is_external THEN
    RAISE EXCEPTION 'record_reversal_local_effect called on an external rail component' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.order_reversal_commands WHERE id = v_command_id FOR UPDATE;

  INSERT INTO public.order_reversal_observations (
    component_id, command_id, kind, observed_amount_halala, observed_currency, payload_sha256
  ) VALUES (
    p_component_id, v_command_id, 'local_effect', v_amount, 'SAR', p_payload_sha256
  );

  UPDATE public.order_reversal_components
     SET state = 'succeeded', version = version + 1
   WHERE id = p_component_id;
END
$function$;

-- Record a provider/POS observation for an external rail and resolve the
-- component's state from it. Ambiguity (timeout) is recorded as a write_intent
-- with no resolution and the component stays 'unknown' (never 'failed').
CREATE FUNCTION public.record_reversal_observation(
  p_component_id uuid,
  p_kind text,
  p_provider text,
  p_provider_object_id text,
  p_provider_event_id text,
  p_observed_amount_halala bigint,
  p_payload_sha256 text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_command_id uuid;
  v_state text;
  v_amount bigint;
  v_provider_payment_id text;
BEGIN
  SELECT command_id, state, amount_halala, provider_payment_id
    INTO v_command_id, v_state, v_amount, v_provider_payment_id
    FROM public.order_reversal_components
   WHERE id = p_component_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reversal component % not found', p_component_id USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.order_reversal_commands WHERE id = v_command_id FOR UPDATE;

  INSERT INTO public.order_reversal_observations (
    component_id, command_id, kind, provider, provider_object_id, provider_event_id,
    observed_amount_halala, observed_currency, payload_sha256
  ) VALUES (
    p_component_id, v_command_id, p_kind, p_provider, p_provider_object_id, p_provider_event_id,
    p_observed_amount_halala, CASE WHEN p_observed_amount_halala IS NULL THEN NULL ELSE 'SAR' END,
    p_payload_sha256
  );

  -- Bind the resulting refund object globally (never rebinds the payment).
  IF p_kind = 'readback_confirmed' AND p_provider_object_id IS NOT NULL THEN
    PERFORM public.bind_phase_b_provider_object(
      p_provider, 'refund', p_provider_object_id, 'order_reversal_component', p_component_id
    );
  END IF;

  -- Resolve state from the observation kind.
  IF p_kind IN ('readback_confirmed', 'webhook') THEN
    IF v_state IN ('processing', 'unknown') THEN
      UPDATE public.order_reversal_components SET state = 'succeeded', version = version + 1
       WHERE id = p_component_id;
    END IF;
  ELSIF p_kind IN ('provider_rejected', 'readback_no_effect') THEN
    IF v_state IN ('processing', 'unknown') THEN
      UPDATE public.order_reversal_components
         SET state = 'failed', last_error_code = p_kind, version = version + 1
       WHERE id = p_component_id;
    END IF;
  ELSIF p_kind = 'write_intent' THEN
    -- Intent recorded before the provider call; leave the component processing.
    NULL;
  END IF;
END
$function$;

-- Mark a still-ambiguous external component as unknown (provider timeout after
-- request). Non-terminal, holds budget, requires later read-back to resolve.
CREATE FUNCTION public.mark_reversal_component_unknown(
  p_component_id uuid,
  p_error_code text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_command_id uuid;
BEGIN
  SELECT command_id INTO v_command_id FROM public.order_reversal_components
   WHERE id = p_component_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reversal component % not found', p_component_id USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.order_reversal_commands WHERE id = v_command_id FOR UPDATE;
  UPDATE public.order_reversal_components
     SET state = 'unknown', last_error_code = p_error_code, version = version + 1
   WHERE id = p_component_id AND state IN ('processing', 'retry');
END
$function$;

-- Finalize the command once its components are terminal. The command guard
-- enforces that succeeded/completed_with_abandonments require no unfinished
-- components; this RPC just picks the right terminal state.
CREATE FUNCTION public.finalize_reversal_command(p_command_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_state text;
  v_unfinished bigint;
  v_abandoned bigint;
  v_succeeded bigint;
  v_target text;
BEGIN
  SELECT state INTO v_state FROM public.order_reversal_commands
   WHERE id = p_command_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reversal command % not found', p_command_id USING ERRCODE = 'P0002';
  END IF;

  SELECT
    count(*) FILTER (WHERE state NOT IN ('succeeded', 'abandoned')),
    count(*) FILTER (WHERE state = 'abandoned'),
    count(*) FILTER (WHERE state = 'succeeded')
    INTO v_unfinished, v_abandoned, v_succeeded
    FROM public.order_reversal_components
   WHERE command_id = p_command_id;

  IF v_unfinished > 0 THEN
    RAISE EXCEPTION 'reversal command has % unfinished components', v_unfinished USING ERRCODE = '22023';
  END IF;

  IF v_succeeded = 0 THEN
    v_target := 'failed';
  ELSIF v_abandoned > 0 THEN
    v_target := 'completed_with_abandonments';
  ELSE
    v_target := 'succeeded';
  END IF;

  -- pending is only reachable as a degenerate no-work command; move via
  -- processing to satisfy the transition graph.
  IF v_state = 'pending' THEN
    UPDATE public.order_reversal_commands SET state = 'processing', version = version + 1
     WHERE id = p_command_id;
  END IF;

  UPDATE public.order_reversal_commands SET state = v_target, version = version + 1
   WHERE id = p_command_id;
  RETURN v_target;
END
$function$;

-- ═════════════════════════════════════════════════════════════════════════
-- Legacy order_reversals: tighten grants, add an explicit service_role policy,
-- preserve historical rows. Projection updates are gated + derived-only.
-- ═════════════════════════════════════════════════════════════════════════
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.order_reversals FROM anon, authenticated;
DROP POLICY IF EXISTS "service_role_all" ON public.order_reversals;
CREATE POLICY "service_role_all" ON public.order_reversals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ═════════════════════════════════════════════════════════════════════════
-- Grants / RLS on the new Phase D tables. REVOKE ALL then narrowly re-grant to
-- service_role. service_role FOR ALL policies are belt-and-suspenders.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE public.phase_d_runtime_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_reversal_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_reversal_basis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_reversal_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_reversal_observations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.phase_d_runtime_controls FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.order_reversal_commands FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.order_reversal_basis FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.order_reversal_components FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.order_reversal_observations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.order_reversal_observations_id_seq FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.phase_d_runtime_controls TO service_role;
GRANT SELECT ON TABLE public.order_reversal_commands TO service_role;
GRANT SELECT ON TABLE public.order_reversal_basis TO service_role;
GRANT SELECT ON TABLE public.order_reversal_components TO service_role;
GRANT SELECT ON TABLE public.order_reversal_observations TO service_role;

DROP POLICY IF EXISTS "service_role_all" ON public.phase_d_runtime_controls;
CREATE POLICY "service_role_all" ON public.phase_d_runtime_controls
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.order_reversal_commands;
CREATE POLICY "service_role_all" ON public.order_reversal_commands
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.order_reversal_basis;
CREATE POLICY "service_role_all" ON public.order_reversal_basis
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.order_reversal_components;
CREATE POLICY "service_role_all" ON public.order_reversal_components
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all" ON public.order_reversal_observations;
CREATE POLICY "service_role_all" ON public.order_reversal_observations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON FUNCTION public.phase_d_require_control(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.phase_d_value_conservation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.open_reversal_command(uuid, text, text, text, text, text, text, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_reversal_component(uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_reversal_local_effect(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_reversal_observation(uuid, text, text, text, text, bigint, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_reversal_component_unknown(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_reversal_command(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.phase_d_value_conservation() TO service_role;
GRANT EXECUTE ON FUNCTION public.open_reversal_command(uuid, text, text, text, text, text, text, text, text, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_reversal_component(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_reversal_local_effect(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_reversal_observation(uuid, text, text, text, text, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_reversal_component_unknown(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_reversal_command(uuid) TO service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- Postconditions
-- ═════════════════════════════════════════════════════════════════════════
DO $phase_d_postconditions$
DECLARE
  legacy_count bigint;
  untrusted_grant_count bigint;
  control_row public.phase_d_runtime_controls%ROWTYPE;
BEGIN
  SELECT * INTO control_row FROM public.phase_d_runtime_controls WHERE singleton;
  IF control_row.reversal_commands_enabled OR control_row.local_rail_worker_enabled
     OR control_row.moyasar_refund_writes_enabled OR control_row.foodics_void_writes_enabled
     OR control_row.legacy_projection_enabled THEN
    RAISE EXCEPTION 'Phase D postcondition: all controls/workers must be off at apply time';
  END IF;

  -- Legacy history preserved (must be >= the 60 rows observed at authoring; the
  -- live legacy writer may have added more, never fewer via this migration).
  SELECT count(*) INTO legacy_count FROM public.order_reversals;
  IF legacy_count < 60 THEN
    RAISE EXCEPTION 'Phase D postcondition: legacy order_reversals shrank to % (expected >= 60)', legacy_count;
  END IF;

  -- No untrusted write grants leaked onto the new tables.
  SELECT count(*) INTO untrusted_grant_count
    FROM information_schema.table_privileges
   WHERE table_schema = 'public'
     AND table_name IN (
       'phase_d_runtime_controls', 'order_reversal_commands', 'order_reversal_basis',
       'order_reversal_components', 'order_reversal_observations'
     )
     AND grantee IN ('PUBLIC', 'anon', 'authenticated');
  IF untrusted_grant_count <> 0 THEN
    RAISE EXCEPTION 'Phase D postcondition: untrusted grants on new tables = %', untrusted_grant_count;
  END IF;

  -- anon/authenticated may no longer write the legacy summary table.
  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges
     WHERE table_schema = 'public' AND table_name = 'order_reversals'
       AND grantee IN ('anon', 'authenticated')
       AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'Phase D postcondition: anon/authenticated still hold write grants on order_reversals';
  END IF;
END
$phase_d_postconditions$;

COMMIT;
