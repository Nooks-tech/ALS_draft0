-- Durable-data-safe rollback for Phase C foundation.
--
-- This rollback is allowed only while Phase C is still a dormant derived copy:
-- no command flag was enabled, no program/product was activated, no runtime
-- reservation/entry/commit/outbox exists, and imported account state did not
-- change. Legacy tables are never modified by this rollback.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $phase_c_rollback_preflight$
BEGIN
  IF pg_catalog.to_regclass('public.phase_c_runtime_controls') IS NULL THEN
    RAISE EXCEPTION 'Phase C rollback: foundation is not installed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.phase_c_runtime_controls
     WHERE wallet_commands_enabled OR loyalty_commands_enabled OR promo_commands_enabled
        OR reward_reservations_enabled OR checkout_commit_enabled
        OR reservation_expiry_worker_enabled OR foodics_type2_rewards_enabled
        OR NOT legacy_compatibility_writes_enabled
        OR updated_by <> 'migration'
  ) THEN
    RAISE EXCEPTION 'Phase C rollback blocked: a runtime/cutover control changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.loyalty_program_versions
     WHERE status <> 'legacy_import' OR reward_reservations_enabled
        OR cashback_reservations_enabled OR foodics_type2_enabled
  ) OR EXISTS (
    SELECT 1 FROM public.loyalty_milestone_products WHERE is_active
  ) THEN
    RAISE EXCEPTION 'Phase C rollback blocked: a loyalty program/product was activated';
  END IF;

  IF EXISTS (SELECT 1 FROM public.wallet_reservations)
     OR EXISTS (SELECT 1 FROM public.loyalty_value_reservations)
     OR EXISTS (SELECT 1 FROM public.reward_reservations)
     OR EXISTS (SELECT 1 FROM public.promo_reservations)
     OR EXISTS (SELECT 1 FROM public.checkout_commits)
     OR EXISTS (SELECT 1 FROM public.checkout_commit_outbox) THEN
    RAISE EXCEPTION 'Phase C rollback blocked: durable runtime work exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.wallet_entries WHERE entry_type <> 'opening_balance'
  ) OR EXISTS (
    SELECT 1 FROM public.loyalty_entries WHERE event_type <> 'opening_balance'
  ) THEN
    RAISE EXCEPTION 'Phase C rollback blocked: non-opening immutable entries exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.wallet_accounts
     WHERE reserved_halala <> 0 OR version <> 0
  ) OR EXISTS (
    SELECT 1 FROM public.loyalty_accounts
     WHERE reserved <> 0 OR version <> 0
  ) OR EXISTS (
    SELECT 1 FROM public.phase_c_value_conservation() WHERE NOT conservation_ok
  ) THEN
    RAISE EXCEPTION 'Phase C rollback blocked: imported account state changed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.wallet_accounts AS a
      JOIN public.phase_c_legacy_value_classifications AS c
        ON c.id = a.opened_from_classification_id
     WHERE a.balance_halala <> c.cached_amount
  ) OR EXISTS (
    SELECT 1
      FROM public.loyalty_accounts AS a
      JOIN public.phase_c_legacy_value_classifications AS c
        ON c.id = a.opened_from_classification_id
     WHERE a.balance <> c.cached_amount
  ) THEN
    RAISE EXCEPTION 'Phase C rollback blocked: opening classification/account diverged';
  END IF;
END
$phase_c_rollback_preflight$;

DROP FUNCTION public.phase_c_value_conservation();
DROP FUNCTION public.commit_checkout_with_reservations(uuid, uuid, text, text);
DROP FUNCTION public.expire_phase_c_reservations(integer);
DROP FUNCTION public.release_attempt_reservations(uuid, text);
DROP FUNCTION public.reserve_promo_for_attempt(uuid, uuid, text);
DROP FUNCTION public.reserve_reward_for_attempt(uuid, uuid, uuid, integer, text);
DROP FUNCTION public.reserve_cashback_for_attempt(uuid, uuid, text);
DROP FUNCTION public.reserve_wallet_for_attempt(uuid, uuid, text);
DROP FUNCTION public.credit_wallet_from_topup_intent(uuid);

DROP TRIGGER phase_c_checkout_outbox_guard ON public.checkout_commit_outbox;
DROP TRIGGER phase_c_promo_reservations_guard ON public.promo_reservations;
DROP TRIGGER phase_c_reward_reservations_guard ON public.reward_reservations;
DROP TRIGGER phase_c_loyalty_value_reservations_guard ON public.loyalty_value_reservations;
DROP TRIGGER phase_c_wallet_reservations_guard ON public.wallet_reservations;
DROP TRIGGER phase_c_deprecated_paths_immutable ON public.phase_c_deprecated_paths;
DROP TRIGGER phase_c_checkout_commits_immutable ON public.checkout_commits;
DROP TRIGGER phase_c_milestone_products_immutable ON public.loyalty_milestone_products;
DROP TRIGGER phase_c_classifications_immutable ON public.phase_c_legacy_value_classifications;
DROP TRIGGER phase_c_loyalty_entries_immutable ON public.loyalty_entries;
DROP TRIGGER phase_c_wallet_entries_immutable ON public.wallet_entries;
DROP TRIGGER phase_c_loyalty_accounts_guard ON public.loyalty_accounts;
DROP TRIGGER phase_c_wallet_accounts_guard ON public.wallet_accounts;

DROP TABLE public.checkout_commit_outbox;
DROP TABLE public.checkout_commits;
DROP TABLE public.promo_reservations;
DROP TABLE public.reward_reservations;
DROP TABLE public.loyalty_milestone_products;
DROP TABLE public.loyalty_value_reservations;
DROP TABLE public.wallet_reservations;
DROP TABLE public.loyalty_entries;
DROP TABLE public.loyalty_accounts;
DROP TABLE public.wallet_entries;
DROP TABLE public.wallet_accounts;
DROP TABLE public.phase_c_deprecated_paths;
DROP TABLE public.loyalty_program_versions;
DROP TABLE public.phase_c_legacy_value_classifications;
DROP TABLE public.phase_c_runtime_controls;

DROP FUNCTION public.phase_c_enforce_outbox_transition();
DROP FUNCTION public.phase_c_enforce_reservation_mutation();
DROP FUNCTION public.phase_c_enforce_account_mutation();
DROP FUNCTION public.phase_c_reject_immutable_mutation();
DROP FUNCTION public.phase_c_require_control(text);

DO $phase_c_rollback_postcondition$
DECLARE
  object_name text;
BEGIN
  FOREACH object_name IN ARRAY ARRAY[
    'phase_c_runtime_controls', 'phase_c_legacy_value_classifications',
    'loyalty_program_versions', 'wallet_accounts', 'wallet_entries',
    'wallet_reservations', 'loyalty_accounts', 'loyalty_entries',
    'loyalty_value_reservations', 'loyalty_milestone_products',
    'reward_reservations', 'promo_reservations', 'checkout_commits',
    'checkout_commit_outbox', 'phase_c_deprecated_paths'
  ]
  LOOP
    IF pg_catalog.to_regclass('public.' || object_name) IS NOT NULL THEN
      RAISE EXCEPTION 'Phase C rollback postcondition: public.% remains', object_name;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('public.commit_checkout_with_reservations(uuid,uuid,text,text)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.reserve_wallet_for_attempt(uuid,uuid,text)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.reserve_cashback_for_attempt(uuid,uuid,text)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.reserve_reward_for_attempt(uuid,uuid,uuid,integer,text)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.reserve_promo_for_attempt(uuid,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Phase C rollback postcondition: a command function remains';
  END IF;
END
$phase_c_rollback_postcondition$;

COMMIT;
