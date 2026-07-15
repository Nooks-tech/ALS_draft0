-- Transactional semantic matrix for the dormant Phase C foundation.
-- This script intentionally rolls back every probe.

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $phase_c_rpc_matrix$
DECLARE
  random_id uuid := gen_random_uuid();
  blocked boolean;
  opening_wallet_entry uuid;
  opening_loyalty_entry uuid;
BEGIN
  -- Every mutating command must hit an OFF control before it can inspect or
  -- mutate caller-selected identifiers.
  blocked := false;
  BEGIN
    PERFORM public.reserve_wallet_for_attempt(random_id, gen_random_uuid(), 'matrix-wallet-0001');
  EXCEPTION WHEN SQLSTATE '55000' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'wallet command did not fail closed'; END IF;

  blocked := false;
  BEGIN
    PERFORM public.reserve_cashback_for_attempt(random_id, gen_random_uuid(), 'matrix-cashback-01');
  EXCEPTION WHEN SQLSTATE '55000' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'cashback command did not fail closed'; END IF;

  blocked := false;
  BEGIN
    PERFORM public.reserve_reward_for_attempt(
      random_id, gen_random_uuid(), gen_random_uuid(), 1, 'matrix-reward-0001'
    );
  EXCEPTION WHEN SQLSTATE '55000' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'reward command did not fail closed'; END IF;

  blocked := false;
  BEGIN
    PERFORM public.reserve_promo_for_attempt(random_id, gen_random_uuid(), 'matrix-promo-00001');
  EXCEPTION WHEN SQLSTATE '55000' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'promo command did not fail closed'; END IF;

  blocked := false;
  BEGIN
    PERFORM public.commit_checkout_with_reservations(
      random_id, gen_random_uuid(), 'matrix-order', 'matrix-commit-0001'
    );
  EXCEPTION WHEN SQLSTATE '55000' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'commit command did not fail closed'; END IF;

  blocked := false;
  BEGIN
    PERFORM public.expire_phase_c_reservations(100);
  EXCEPTION WHEN SQLSTATE '55000' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'expiry worker did not fail closed'; END IF;

  -- Runtime dependency constraints prevent an incomplete cutover and prevent
  -- Foodics Type 2 from bypassing exact-product reservations.
  blocked := false;
  BEGIN
    UPDATE public.phase_c_runtime_controls
       SET checkout_commit_enabled = true;
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'partial checkout cutover was accepted'; END IF;

  blocked := false;
  BEGIN
    UPDATE public.phase_c_runtime_controls
       SET foodics_type2_rewards_enabled = true;
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Foodics Type 2 bypass was accepted'; END IF;

  -- Immutable opening evidence and ledgers cannot be edited/deleted even by
  -- the migration owner. Nested blocks roll back the expected errors only.
  SELECT id INTO opening_wallet_entry FROM public.wallet_entries LIMIT 1;
  IF opening_wallet_entry IS NOT NULL THEN
    blocked := false;
    BEGIN
      UPDATE public.wallet_entries SET metadata = metadata || '{"tampered":true}'::jsonb
       WHERE id = opening_wallet_entry;
    EXCEPTION WHEN SQLSTATE '55000' THEN blocked := true;
    END;
    IF NOT blocked THEN RAISE EXCEPTION 'wallet entry mutation was accepted'; END IF;
  END IF;

  SELECT id INTO opening_loyalty_entry FROM public.loyalty_entries LIMIT 1;
  IF opening_loyalty_entry IS NOT NULL THEN
    blocked := false;
    BEGIN
      DELETE FROM public.loyalty_entries WHERE id = opening_loyalty_entry;
    EXCEPTION WHEN SQLSTATE '55000' THEN blocked := true;
    END;
    IF NOT blocked THEN RAISE EXCEPTION 'loyalty entry deletion was accepted'; END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.phase_c_value_conservation() WHERE NOT conservation_ok) THEN
    RAISE EXCEPTION 'matrix changed value conservation';
  END IF;
END
$phase_c_rpc_matrix$;

ROLLBACK;
