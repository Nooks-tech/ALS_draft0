-- DISPOSABLE LOCAL DATABASE ONLY.
-- Prepares a 100-client budget-cap race: 100 partial_refund commands each add
-- one 200-halala card component against ONE shared card basis (captured 10000).
-- 100*200 = 20000 > 10000, so the per-rail budget CHECK must admit exactly 50
-- and reject the rest. The PowerShell runner enforces localhost + destructive
-- opt-in before this file is used.

\set ON_ERROR_STOP on

DO $safety$
BEGIN
  IF current_setting('phase_d.allow_destructive_test', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Set PGOPTIONS=-c phase_d.allow_destructive_test=on on a disposable local database';
  END IF;
END
$safety$;

-- TRUNCATE (not DELETE) bypasses the durability triggers on these tables — safe
-- ONLY because this is a disposable local test DB dedicated to the race.
TRUNCATE public.order_reversal_observations, public.order_reversal_components,
  public.order_reversal_basis, public.order_reversal_commands CASCADE;

DROP TABLE IF EXISTS public.phase_d_concurrency_fixture;
CREATE TABLE public.phase_d_concurrency_fixture (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  merchant_id uuid NOT NULL,
  captured_basis_halala bigint NOT NULL,
  per_component_halala bigint NOT NULL,
  expected_winners integer NOT NULL
);

DO $setup$
DECLARE m uuid;
BEGIN
  SELECT id INTO m FROM public.merchants LIMIT 1;
  IF m IS NULL THEN RAISE EXCEPTION 'Phase D concurrency fixture needs at least one merchant'; END IF;

  UPDATE public.phase_d_runtime_controls
     SET reversal_commands_enabled = true,
         updated_at = clock_timestamp(),
         updated_by = 'phase_d_concurrency_test'
   WHERE singleton;

  INSERT INTO public.phase_d_concurrency_fixture (merchant_id, captured_basis_halala, per_component_halala, expected_winners)
  VALUES (m, 10000, 200, 50);
END
$setup$;
