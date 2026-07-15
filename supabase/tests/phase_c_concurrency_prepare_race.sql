\set ON_ERROR_STOP on

DO $assert_one_winner$
DECLARE
  reservation public.wallet_reservations%ROWTYPE;
  fixture public.phase_c_concurrency_fixture%ROWTYPE;
  loser public.phase_c_concurrency_fixture%ROWTYPE;
  account public.wallet_accounts%ROWTYPE;
  replay_id uuid;
  conflict_blocked boolean := false;
  illegal_release_blocked boolean := false;
BEGIN
  IF (SELECT count(*) FROM public.wallet_reservations r
       JOIN public.phase_c_concurrency_fixture f ON f.attempt_id = r.payment_attempt_id) <> 1 THEN
    RAISE EXCEPTION '100-way reserve race did not produce exactly one winner';
  END IF;
  SELECT r.* INTO STRICT reservation
    FROM public.wallet_reservations AS r
    JOIN public.phase_c_concurrency_fixture AS f ON f.attempt_id = r.payment_attempt_id;
  SELECT * INTO STRICT fixture FROM public.phase_c_concurrency_fixture
   WHERE attempt_id = reservation.payment_attempt_id;
  UPDATE public.phase_c_concurrency_fixture SET is_winner = true
   WHERE worker_id = fixture.worker_id;
  SELECT * INTO STRICT account FROM public.wallet_accounts WHERE id = fixture.account_id;
  IF account.reserved_halala <> fixture.original_reserved_halala + fixture.amount_halala
     OR account.balance_halala - account.reserved_halala <> 0 THEN
    RAISE EXCEPTION 'winner did not reserve the exact available balance once';
  END IF;

  -- Process retry: the winner returns the same durable reservation and does
  -- not reserve a second time.
  replay_id := public.reserve_wallet_for_attempt(
    fixture.attempt_id, fixture.component_id, fixture.idempotency_key
  );
  IF replay_id <> reservation.id THEN
    RAISE EXCEPTION 'idempotent process retry returned a different reservation';
  END IF;

  -- Cross-attempt replay of one tenant-scoped idempotency key is a conflict.
  SELECT * INTO STRICT loser FROM public.phase_c_concurrency_fixture
   WHERE NOT is_winner ORDER BY worker_id LIMIT 1;
  BEGIN
    PERFORM public.reserve_wallet_for_attempt(
      loser.attempt_id, loser.component_id, fixture.idempotency_key
    );
  EXCEPTION WHEN unique_violation THEN conflict_blocked := true;
  END;
  IF NOT conflict_blocked THEN
    RAISE EXCEPTION 'cross-attempt idempotency replay was accepted';
  END IF;

  UPDATE public.phase_c_runtime_controls
     SET loyalty_commands_enabled = true,
         promo_commands_enabled = true,
         checkout_commit_enabled = true,
         reservation_expiry_worker_enabled = true,
         updated_at = clock_timestamp(),
         updated_by = 'phase_c_concurrency_test'
   WHERE singleton;

  -- Release cannot race a still-live attempt by presenting an arbitrary reason.
  BEGIN
    PERFORM public.release_attempt_reservations(fixture.attempt_id, 'attempt_expired');
  EXCEPTION WHEN check_violation THEN illegal_release_blocked := true;
  END;
  IF NOT illegal_release_blocked THEN
    RAISE EXCEPTION 'live attempt accepted an expiry release';
  END IF;

  UPDATE public.payment_attempts
     SET state = 'expired', version = version + 1
   WHERE id = fixture.attempt_id AND state = 'created';
  IF NOT FOUND THEN RAISE EXCEPTION 'winner attempt could not transition to expired'; END IF;
END
$assert_one_winner$;
