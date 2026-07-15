-- Proves the per-rail budget accumulator is race-safe: after the 100-client
-- budget-cap race, the shared card basis must be reserved EXACTLY at the cap
-- (never above), admit exactly the expected number of winners, and conserve.

\set ON_ERROR_STOP on

DO $assert$
DECLARE
  fixture public.phase_d_concurrency_fixture%ROWTYPE;
  reserved bigint;
  captured bigint;
  settled bigint;
  comp_count integer;
  conservation_failures bigint;
BEGIN
  SELECT * INTO STRICT fixture FROM public.phase_d_concurrency_fixture WHERE singleton;

  SELECT reversal_reserved_halala, captured_basis_halala, reversal_settled_halala
    INTO reserved, captured, settled
    FROM public.order_reversal_basis
   WHERE order_id = 'pd-budget-race' AND rail = 'card';

  SELECT count(*) INTO comp_count
    FROM public.order_reversal_components WHERE order_id = 'pd-budget-race';

  -- The cardinal invariant: the accumulator never exceeds the frozen cap.
  IF reserved > captured THEN
    RAISE EXCEPTION 'Phase D budget race: reserved % exceeded captured cap %', reserved, captured;
  END IF;

  -- Each winner reserved exactly per_component_halala; nothing settled yet.
  IF reserved <> comp_count * fixture.per_component_halala OR settled <> 0 THEN
    RAISE EXCEPTION 'Phase D budget race: reserved %/settled % inconsistent with % components',
      reserved, settled, comp_count;
  END IF;

  -- Exactly floor(cap / per_component) winners; the rest rejected by the CHECK.
  IF comp_count <> fixture.expected_winners THEN
    RAISE EXCEPTION 'Phase D budget race: expected % winners, got %', fixture.expected_winners, comp_count;
  END IF;

  SELECT count(*) INTO conservation_failures
    FROM public.phase_d_value_conservation() WHERE NOT conservation_ok;
  IF conservation_failures <> 0 THEN
    RAISE EXCEPTION 'Phase D budget race: % conservation failures', conservation_failures;
  END IF;
END
$assert$;

SELECT 'phase_d budget-cap race: exactly one cap of winners, no overshoot, conserved' AS result;
