-- DISPOSABLE LOCAL DATABASE ONLY.
-- Creates 100 independent attempts competing for one wallet balance that can
-- fund exactly one reservation. The PowerShell runner enforces localhost and
-- an explicit destructive-test opt-in before this file is used.

\set ON_ERROR_STOP on

DO $safety$
BEGIN
  IF current_setting('phase_c.allow_destructive_test', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Set PGOPTIONS=-c phase_c.allow_destructive_test=on on a disposable local database';
  END IF;
END
$safety$;

DROP TABLE IF EXISTS public.phase_c_concurrency_fixture;
CREATE TABLE public.phase_c_concurrency_fixture (
  worker_id integer PRIMARY KEY CHECK (worker_id BETWEEN 1 AND 100),
  account_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  component_id uuid NOT NULL,
  amount_halala bigint NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  original_reserved_halala bigint NOT NULL,
  is_winner boolean NOT NULL DEFAULT false
);

DO $setup$
DECLARE
  account public.wallet_accounts%ROWTYPE;
  branch_id uuid;
  quote_id uuid;
  v_attempt_id uuid;
  component_id uuid;
  available bigint;
  worker integer;
BEGIN
  SELECT a.* INTO account
    FROM public.wallet_accounts AS a
   WHERE a.balance_halala - a.reserved_halala > 0
     AND EXISTS (
       SELECT 1 FROM public.branch_mappings AS b WHERE b.merchant_id = a.merchant_id
     )
   ORDER BY a.balance_halala - a.reserved_halala DESC, a.id
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Concurrency fixture needs one imported funded wallet with a merchant branch';
  END IF;
  SELECT b.id INTO STRICT branch_id
    FROM public.branch_mappings AS b
   WHERE b.merchant_id = account.merchant_id
   ORDER BY b.id LIMIT 1;
  available := account.balance_halala - account.reserved_halala;

  UPDATE public.phase_c_runtime_controls
     SET wallet_commands_enabled = true,
         updated_at = clock_timestamp(),
         updated_by = 'phase_c_concurrency_test'
   WHERE singleton;

  FOR worker IN 1..100 LOOP
    quote_id := gen_random_uuid();
    INSERT INTO public.checkout_quotes (
      id, merchant_id, customer_id, branch_id, channel, fulfillment_type,
      currency, subtotal_halala, modifier_total_halala, tax_halala,
      delivery_fee_halala, other_fee_halala, promo_discount_halala,
      reward_discount_halala, other_discount_halala, total_halala,
      catalog_version, pricing_version, source_snapshot, request_fingerprint,
      idempotency_key, expires_at
    ) VALUES (
      quote_id, account.merchant_id, account.customer_id, branch_id,
      'mobile', 'pickup', 'SAR', available, 0, 0, 0, 0, 0, 0, 0, available,
      'phase-c-concurrency', 'phase-c-concurrency', '{}'::jsonb,
      lpad(to_hex(worker), 64, '0'), 'phase-c-concurrency-quote-' || worker,
      clock_timestamp() + interval '20 minutes'
    );

    v_attempt_id := public.create_payment_attempt(
      pg_catalog.jsonb_build_object(
        'quote_id', quote_id,
        'merchant_id', account.merchant_id,
        'customer_id', account.customer_id,
        'provider', 'wallet',
        'tender_type', 'wallet',
        'amount_halala', available,
        'currency', 'SAR',
        'return_url_key', 'none',
        'idempotency_key', 'phase-c-concurrency-attempt-' || worker,
        'request_fingerprint', lpad(to_hex(1000 + worker), 64, '0')
      ),
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'component_no', 1,
        'tender_type', 'wallet',
        'amount_halala', available
      ))
    );
    SELECT c.id INTO STRICT component_id
      FROM public.payment_attempt_components AS c
     WHERE c.attempt_id = v_attempt_id AND c.component_no = 1;

    INSERT INTO public.phase_c_concurrency_fixture (
      worker_id, account_id, attempt_id, component_id, amount_halala,
      idempotency_key, original_reserved_halala
    ) VALUES (
      worker, account.id, v_attempt_id, component_id, available,
      'phase-c-wallet-race-' || lpad(worker::text, 3, '0'),
      account.reserved_halala
    );
  END LOOP;
END
$setup$;
