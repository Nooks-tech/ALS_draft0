-- loyalty_transactions.metadata is NOT NULL, but several RPCs
-- (redeem_loyalty_cashback, credit_customer_cashback, and others) insert an
-- EXPLICIT NULL whenever their p_metadata argument is omitted by the caller,
-- tripping 23502 and breaking those flows (cashback checkout returned 503;
-- dashboard cashback adjust failed). A BEFORE INSERT trigger coalesces a NULL
-- metadata to '{}' so no insert can trip the constraint AND no NULL rows ever
-- exist (readers that assume metadata is an object stay safe). Global,
-- future-proof — no need to patch each RPC. Confirmed live 2026-07-16.

CREATE OR REPLACE FUNCTION public.loyalty_tx_metadata_default()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.metadata IS NULL THEN
    NEW.metadata := '{}'::jsonb;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS trg_loyalty_tx_metadata_default ON public.loyalty_transactions;
CREATE TRIGGER trg_loyalty_tx_metadata_default
  BEFORE INSERT ON public.loyalty_transactions
  FOR EACH ROW EXECUTE FUNCTION public.loyalty_tx_metadata_default();

-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_loyalty_tx_metadata_default ON public.loyalty_transactions;
--   DROP FUNCTION IF EXISTS public.loyalty_tx_metadata_default();
