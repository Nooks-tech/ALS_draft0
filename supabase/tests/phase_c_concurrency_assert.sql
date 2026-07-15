\set ON_ERROR_STOP on

DO $final_assert$
DECLARE
  fixture public.phase_c_concurrency_fixture%ROWTYPE;
  reservation public.wallet_reservations%ROWTYPE;
  account public.wallet_accounts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT fixture FROM public.phase_c_concurrency_fixture WHERE is_winner;
  SELECT * INTO STRICT reservation FROM public.wallet_reservations
   WHERE payment_attempt_id = fixture.attempt_id;
  SELECT * INTO STRICT account FROM public.wallet_accounts WHERE id = fixture.account_id;

  IF reservation.state <> 'expired' OR reservation.released_at IS NULL
     OR account.reserved_halala <> fixture.original_reserved_halala THEN
    RAISE EXCEPTION 'release/replay race did not converge to one expired reservation';
  END IF;
  IF (SELECT count(*) FROM public.wallet_reservations r
       JOIN public.phase_c_concurrency_fixture f ON f.attempt_id = r.payment_attempt_id) <> 1 THEN
    RAISE EXCEPTION 'release/replay race created additional reservations';
  END IF;
  IF EXISTS (SELECT 1 FROM public.phase_c_value_conservation() WHERE NOT conservation_ok) THEN
    RAISE EXCEPTION '100-way races violated ledger/account conservation';
  END IF;
END
$final_assert$;
