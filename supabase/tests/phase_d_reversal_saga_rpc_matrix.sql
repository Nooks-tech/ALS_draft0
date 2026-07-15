-- Role-boundary checks for the Phase D saga RPCs. Untrusted roles must fail at
-- EXECUTE (insufficient_privilege), never reaching a function body. service_role
-- reaches the body (and is stopped by the disabled control gate). Rolls back.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL statement_timeout = '30s';

DO $phase_d_rpc_matrix$
DECLARE
  role_name text;
  rpc_call text;
  stacked_message text;
BEGIN
  IF CURRENT_USER <> 'postgres' THEN
    RAISE EXCEPTION 'Phase D RPC matrix must run as fixture owner postgres';
  END IF;

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']::text[]
  LOOP
    FOREACH rpc_call IN ARRAY ARRAY[
      'SELECT public.open_reversal_command(''00000000-0000-0000-0000-000000000000''::uuid, ''o'', ''full_cancel'', ''k'', ''f'', ''system'', NULL, NULL, ''p'', ''[]''::jsonb, ''[]''::jsonb)',
      'SELECT public.claim_reversal_component(''00000000-0000-0000-0000-000000000000''::uuid, ''w'', 60)',
      'SELECT public.record_reversal_local_effect(''00000000-0000-0000-0000-000000000000''::uuid, ''s'')',
      'SELECT public.record_reversal_observation(''00000000-0000-0000-0000-000000000000''::uuid, ''webhook'', ''moyasar'', ''x'', ''e'', 1, ''s'')',
      'SELECT public.mark_reversal_component_unknown(''00000000-0000-0000-0000-000000000000''::uuid, ''e'')',
      'SELECT public.finalize_reversal_command(''00000000-0000-0000-0000-000000000000''::uuid)',
      'SELECT public.phase_d_value_conservation()'
    ]
    LOOP
      BEGIN
        EXECUTE pg_catalog.format('SET LOCAL ROLE %I', role_name);
        EXECUTE rpc_call;
        EXECUTE 'RESET ROLE';
        RAISE EXCEPTION 'Phase D RPC matrix: % unexpectedly executed %', role_name, rpc_call;
      EXCEPTION
        WHEN insufficient_privilege THEN
          EXECUTE 'RESET ROLE';
        WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS stacked_message = MESSAGE_TEXT;
          EXECUTE 'RESET ROLE';
          RAISE EXCEPTION 'Phase D RPC matrix: % reached RPC body (SQLSTATE %, msg %)',
            role_name, SQLSTATE, stacked_message;
      END;
    END LOOP;
  END LOOP;

  -- service_role reaches the body: open is gated by the disabled control and
  -- must raise the control error (0A000), proving it executed past EXECUTE.
  BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
    PERFORM public.open_reversal_command(
      '00000000-0000-0000-0000-000000000000'::uuid, 'o', 'full_cancel', 'k', 'f',
      'system', NULL, NULL, 'p', '[]'::jsonb, '[]'::jsonb
    );
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'Phase D RPC matrix: open unexpectedly succeeded while disabled';
  EXCEPTION
    WHEN insufficient_privilege THEN
      EXECUTE 'RESET ROLE';
      RAISE EXCEPTION 'Phase D RPC matrix: service_role could not execute open_reversal_command';
    WHEN feature_not_supported THEN
      -- 0A000: control disabled — service_role reached the body as intended.
      EXECUTE 'RESET ROLE';
  END;
END
$phase_d_rpc_matrix$;

SELECT 'phase_d_reversal_saga RPC role matrix passed' AS result;
ROLLBACK;
