-- Semantic behavior test for the Phase D reversal saga. Runs as the fixture
-- owner inside a rollback transaction (see run harness / rehearsal). Exercises
-- the load-bearing invariants with a two-rail command (external card + local
-- wallet) on a synthetic order.

\set ON_ERROR_STOP on

DO $phase_d_semantics$
DECLARE
  v_merchant uuid;
  v_order text := 'phase-d-test-order-1';
  v_cmd uuid;
  v_cmd2 uuid;
  v_card_comp uuid;
  v_wallet_comp uuid;
  v_basis jsonb;
  v_components jsonb;
  v_reserved bigint;
  v_settled bigint;
  v_conservation_failures bigint;
  v_state text;
  v_target text;
  v_raised boolean;
BEGIN
  IF CURRENT_USER <> 'postgres' THEN
    RAISE EXCEPTION 'Phase D semantic test must run as fixture owner postgres';
  END IF;

  SELECT id INTO v_merchant FROM public.merchants LIMIT 1;
  IF v_merchant IS NULL THEN
    RAISE EXCEPTION 'Phase D semantic test: no merchant available';
  END IF;

  -- The API is gated OFF by default; enable it inside this rolled-back txn.
  UPDATE public.phase_d_runtime_controls SET reversal_commands_enabled = true;

  v_basis := jsonb_build_array(
    jsonb_build_object('rail', 'card', 'captured_basis_halala', 5000, 'basis_source', 'payment_attempt_component', 'evidence_sha256', 'aa'),
    jsonb_build_object('rail', 'wallet', 'captured_basis_halala', 2000, 'basis_source', 'payment_attempt_component', 'evidence_sha256', 'bb')
  );
  v_components := jsonb_build_array(
    jsonb_build_object('rail', 'card', 'amount_halala', 5000, 'is_external', true, 'provider', 'moyasar', 'provider_payment_id', 'pay_phase_d_1'),
    jsonb_build_object('rail', 'wallet', 'amount_halala', 2000, 'is_external', false)
  );

  -- 1. Open a command.
  v_cmd := public.open_reversal_command(
    v_merchant, v_order, 'full_cancel', 'idem-key-1', 'fp-1',
    'system', NULL, 'test', 'plan-sha-1', v_basis, v_components
  );
  IF v_cmd IS NULL THEN RAISE EXCEPTION 'test: open returned null'; END IF;

  -- 2. Idempotent replay: same key + same fingerprint -> same id.
  v_cmd2 := public.open_reversal_command(
    v_merchant, v_order, 'full_cancel', 'idem-key-1', 'fp-1',
    'system', NULL, 'test', 'plan-sha-1', v_basis, v_components
  );
  IF v_cmd2 IS DISTINCT FROM v_cmd THEN
    RAISE EXCEPTION 'test: idempotent replay returned a different command';
  END IF;

  -- 3. Same key + different fingerprint -> conflict.
  v_raised := false;
  BEGIN
    PERFORM public.open_reversal_command(
      v_merchant, v_order, 'full_cancel', 'idem-key-1', 'fp-DIFFERENT',
      'system', NULL, 'test', 'plan-sha-1', v_basis, v_components
    );
  EXCEPTION WHEN unique_violation THEN v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'test: fingerprint conflict not raised'; END IF;

  -- 4. Over-cap component is rejected by the per-rail budget CHECK.
  v_raised := false;
  BEGIN
    PERFORM public.open_reversal_command(
      v_merchant, 'phase-d-test-order-overcap', 'partial_refund', 'idem-overcap', 'fp-oc',
      'system', NULL, 'test', 'plan-sha-oc',
      jsonb_build_array(jsonb_build_object('rail', 'card', 'captured_basis_halala', 1000, 'basis_source', 'legacy_derived', 'evidence_sha256', 'cc')),
      jsonb_build_array(jsonb_build_object('rail', 'card', 'amount_halala', 5000, 'is_external', true, 'provider', 'moyasar', 'provider_payment_id', 'pay_overcap'))
    );
  EXCEPTION WHEN check_violation THEN v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'test: over-cap component was not rejected'; END IF;

  SELECT id INTO v_card_comp FROM public.order_reversal_components
   WHERE command_id = v_cmd AND rail = 'card';
  SELECT id INTO v_wallet_comp FROM public.order_reversal_components
   WHERE command_id = v_cmd AND rail = 'wallet';

  -- Both rails reserved their full basis.
  SELECT reversal_reserved_halala INTO v_reserved FROM public.order_reversal_basis
   WHERE order_id = v_order AND rail = 'card';
  IF v_reserved <> 5000 THEN RAISE EXCEPTION 'test: card reserved expected 5000 got %', v_reserved; END IF;

  -- 5. A component cannot succeed without a proving observation.
  v_raised := false;
  BEGIN
    UPDATE public.order_reversal_components SET state = 'succeeded', version = version + 1
     WHERE id = v_wallet_comp;
  EXCEPTION WHEN check_violation THEN v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'test: component succeeded without an effect observation'; END IF;

  -- 6. Local rail settles atomically via its effect RPC.
  PERFORM public.record_reversal_local_effect(v_wallet_comp, 'local-sha-1');
  SELECT state INTO v_state FROM public.order_reversal_components WHERE id = v_wallet_comp;
  IF v_state <> 'succeeded' THEN RAISE EXCEPTION 'test: wallet not succeeded, got %', v_state; END IF;
  SELECT reversal_settled_halala, reversal_reserved_halala INTO v_settled, v_reserved
    FROM public.order_reversal_basis WHERE order_id = v_order AND rail = 'wallet';
  IF v_settled <> 2000 OR v_reserved <> 0 THEN
    RAISE EXCEPTION 'test: wallet budget wrong settled=% reserved=%', v_settled, v_reserved;
  END IF;

  -- 7. External rail: claim -> processing; timeout -> unknown (budget HELD).
  PERFORM public.claim_reversal_component(v_card_comp, 'worker-1', 600);
  SELECT state INTO v_state FROM public.order_reversal_components WHERE id = v_card_comp;
  IF v_state <> 'processing' THEN RAISE EXCEPTION 'test: card not processing, got %', v_state; END IF;

  PERFORM public.mark_reversal_component_unknown(v_card_comp, 'provider_timeout');
  SELECT state INTO v_state FROM public.order_reversal_components WHERE id = v_card_comp;
  IF v_state <> 'unknown' THEN RAISE EXCEPTION 'test: card not unknown, got %', v_state; END IF;
  -- Unknown must still HOLD the reserved budget (money might have left).
  SELECT reversal_reserved_halala, reversal_settled_halala INTO v_reserved, v_settled
    FROM public.order_reversal_basis WHERE order_id = v_order AND rail = 'card';
  IF v_reserved <> 5000 OR v_settled <> 0 THEN
    RAISE EXCEPTION 'test: unknown card released budget reserved=% settled=%', v_reserved, v_settled;
  END IF;

  -- 8. Command cannot finalize while the card component is unfinished.
  v_raised := false;
  BEGIN
    PERFORM public.finalize_reversal_command(v_cmd);
  EXCEPTION WHEN OTHERS THEN v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'test: command finalized with an unfinished component'; END IF;

  -- 9. Read-back confirms the card refund -> succeeded + settled.
  PERFORM public.record_reversal_observation(
    v_card_comp, 'readback_confirmed', 'moyasar', 'refund_obj_1', 'evt_1', 5000, 'readback-sha-1'
  );
  SELECT state INTO v_state FROM public.order_reversal_components WHERE id = v_card_comp;
  IF v_state <> 'succeeded' THEN RAISE EXCEPTION 'test: card not succeeded after readback, got %', v_state; END IF;
  SELECT reversal_settled_halala, reversal_reserved_halala INTO v_settled, v_reserved
    FROM public.order_reversal_basis WHERE order_id = v_order AND rail = 'card';
  IF v_settled <> 5000 OR v_reserved <> 0 THEN
    RAISE EXCEPTION 'test: card budget wrong after readback settled=% reserved=%', v_settled, v_reserved;
  END IF;

  -- 10. Now finalize succeeds.
  v_target := public.finalize_reversal_command(v_cmd);
  IF v_target <> 'succeeded' THEN RAISE EXCEPTION 'test: finalize target expected succeeded got %', v_target; END IF;

  -- 11. Conservation holds everywhere.
  SELECT count(*) INTO v_conservation_failures
    FROM public.phase_d_value_conservation() WHERE NOT conservation_ok;
  IF v_conservation_failures <> 0 THEN
    RAISE EXCEPTION 'test: conservation failures %', v_conservation_failures;
  END IF;

  -- 12. The refund object is globally bound and cannot be reused by a payment.
  v_raised := false;
  BEGIN
    PERFORM public.bind_phase_b_provider_object('moyasar', 'refund', 'refund_obj_1', 'payment_attempt', gen_random_uuid());
  EXCEPTION WHEN unique_violation THEN v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'test: refund object was rebound to another domain'; END IF;

  RAISE NOTICE 'PHASE_D_SEMANTICS_OK';
END
$phase_d_semantics$;

SELECT 'phase_d_reversal_saga semantics passed' AS result;
