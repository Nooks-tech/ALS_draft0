-- Durable-data-safe rollback for the Phase D reversal saga.
--
-- Allowed only while Phase D is still dormant: no control/worker flag changed,
-- and no durable command / basis / component / observation row exists. The
-- legacy public.order_reversals summary and its 60+ historical rows are never
-- modified. The anon/authenticated write-grant REVOKE that Phase D performed on
-- order_reversals IS faithfully restored so this rollback is a true inverse
-- (those grants were always RLS-contained — anon/authenticated have no write
-- policy — so restoring them reopens nothing on Frankfurt).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $phase_d_rollback_preflight$
BEGIN
  IF pg_catalog.to_regclass('public.phase_d_runtime_controls') IS NULL THEN
    RAISE EXCEPTION 'Phase D rollback: saga is not installed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.phase_d_runtime_controls
     WHERE reversal_commands_enabled OR local_rail_worker_enabled
        OR moyasar_refund_writes_enabled OR foodics_void_writes_enabled
        OR legacy_projection_enabled
        OR updated_by <> 'migration'
  ) THEN
    RAISE EXCEPTION 'Phase D rollback blocked: a runtime/worker control changed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.order_reversal_commands)
     OR EXISTS (SELECT 1 FROM public.order_reversal_basis)
     OR EXISTS (SELECT 1 FROM public.order_reversal_components)
     OR EXISTS (SELECT 1 FROM public.order_reversal_observations) THEN
    RAISE EXCEPTION 'Phase D rollback blocked: durable reversal command history exists';
  END IF;

  -- No provider object may still be bound to a reversal component (there should
  -- be none, since no durable component rows exist).
  IF EXISTS (
    SELECT 1 FROM public.provider_object_bindings
     WHERE source_domain = 'order_reversal_component' OR object_kind = 'refund'
  ) THEN
    RAISE EXCEPTION 'Phase D rollback blocked: a refund provider binding still exists';
  END IF;
END
$phase_d_rollback_preflight$;

DROP FUNCTION public.finalize_reversal_command(uuid);
DROP FUNCTION public.mark_reversal_component_unknown(uuid, text);
DROP FUNCTION public.record_reversal_observation(uuid, text, text, text, text, bigint, text);
DROP FUNCTION public.record_reversal_local_effect(uuid, text);
DROP FUNCTION public.claim_reversal_component(uuid, text, integer);
DROP FUNCTION public.open_reversal_command(uuid, text, text, text, text, text, text, text, text, jsonb, jsonb);
DROP FUNCTION public.phase_d_value_conservation();

DROP TRIGGER order_reversal_components_guard ON public.order_reversal_components;
DROP TRIGGER order_reversal_commands_guard ON public.order_reversal_commands;
DROP TRIGGER order_reversal_observations_immutable ON public.order_reversal_observations;
DROP TRIGGER order_reversal_basis_guard ON public.order_reversal_basis;
DROP TRIGGER phase_d_runtime_controls_guard ON public.phase_d_runtime_controls;

DROP TABLE public.order_reversal_observations;
DROP TABLE public.order_reversal_components;
DROP TABLE public.order_reversal_basis;
DROP TABLE public.order_reversal_commands;
DROP TABLE public.phase_d_runtime_controls;

DROP FUNCTION public.enforce_reversal_component_transition();
DROP FUNCTION public.enforce_reversal_command_transition();
DROP FUNCTION public.reject_reversal_observation_mutation();
DROP FUNCTION public.enforce_reversal_basis_mutation();
DROP FUNCTION public.enforce_phase_d_controls_mutation();
DROP FUNCTION public.phase_d_require_control(text);

-- Restore the Phase B provider_object_bindings constraints to their pre-D shape.
ALTER TABLE public.provider_object_bindings
  DROP CONSTRAINT provider_object_bindings_kind_valid;
ALTER TABLE public.provider_object_bindings
  ADD CONSTRAINT provider_object_bindings_kind_valid
  CHECK (object_kind IN ('payment', 'invoice'));
ALTER TABLE public.provider_object_bindings
  DROP CONSTRAINT provider_object_bindings_domain_valid;
ALTER TABLE public.provider_object_bindings
  ADD CONSTRAINT provider_object_bindings_domain_valid
  CHECK (source_domain IN ('payment_attempt', 'wallet_topup'));

-- Restore legacy order_reversals to its pre-D grant/policy state.
DROP POLICY IF EXISTS "service_role_all" ON public.order_reversals;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.order_reversals TO anon, authenticated;

DO $phase_d_rollback_postcondition$
DECLARE
  object_name text;
  legacy_count bigint;
BEGIN
  FOREACH object_name IN ARRAY ARRAY[
    'phase_d_runtime_controls', 'order_reversal_commands', 'order_reversal_basis',
    'order_reversal_components', 'order_reversal_observations'
  ]
  LOOP
    IF pg_catalog.to_regclass('public.' || object_name) IS NOT NULL THEN
      RAISE EXCEPTION 'Phase D rollback postcondition: public.% remains', object_name;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('public.open_reversal_command(uuid,text,text,text,text,text,text,text,text,jsonb,jsonb)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.finalize_reversal_command(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Phase D rollback postcondition: a saga function remains';
  END IF;

  SELECT count(*) INTO legacy_count FROM public.order_reversals;
  IF legacy_count < 60 THEN
    RAISE EXCEPTION 'Phase D rollback postcondition: legacy order_reversals shrank to %', legacy_count;
  END IF;
END
$phase_d_rollback_postcondition$;

COMMIT;
