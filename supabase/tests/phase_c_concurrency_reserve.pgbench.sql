\set worker_id :client_id + 1
SELECT public.reserve_wallet_for_attempt(
  fixture.attempt_id,
  fixture.component_id,
  fixture.idempotency_key
)
FROM public.phase_c_concurrency_fixture AS fixture
WHERE fixture.worker_id = :worker_id;
