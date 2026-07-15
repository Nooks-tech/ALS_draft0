-- All clients resolve the winner from the table. Even client ids release;
-- odd client ids replay the original reserve after terminalization.
SELECT CASE WHEN mod(:client_id, 2) = 0 THEN
  public.release_attempt_reservations(fixture.attempt_id, 'attempt_expired')::text
ELSE
  public.reserve_wallet_for_attempt(
    fixture.attempt_id, fixture.component_id, fixture.idempotency_key
  )::text
END
FROM public.phase_c_concurrency_fixture AS fixture
WHERE fixture.is_winner;
