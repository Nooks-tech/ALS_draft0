-- Phase 3 — money-write idempotency (audit 2026-07-07: H7, M16, M14, M17)
-- Applied to live DB (setynlgmdzaceegrlgwg) 2026-07-08; this file is the version-controlled record.
-- Zero live dupes existed (verified) so plain CREATE UNIQUE INDEX is safe.
-- Verified after apply: an aborted-transaction test showed two identical topups -> 1 tx/1 credit,
-- two identical spends -> 1 tx/1 debit (balance 12000 not 14000); dedup baseline stayed all-zero.
--
-- Money math unchanged: these only add unique indexes + ON CONFLICT DO NOTHING and reorder
-- the RPCs to insert-tx-first-then-move-balance (mirroring the existing refund branch), so a
-- duplicate call is a true no-op instead of a double credit/debit. No amounts changed, no new deduct.

-- H7 wallet top-up double-credit, M16 wallet spend double-debit, M14 cashback restore double-credit,
-- M17 two orders sharing one payment_id.
CREATE UNIQUE INDEX IF NOT EXISTS customer_wallet_tx_topup_per_payment
  ON public.customer_wallet_transactions (customer_id, merchant_id, payment_id) WHERE entry_type='topup';
CREATE UNIQUE INDEX IF NOT EXISTS customer_wallet_tx_spend_per_order
  ON public.customer_wallet_transactions (customer_id, merchant_id, order_id) WHERE entry_type='spend';
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_tx_cashback_restore_per_order
  ON public.loyalty_transactions (customer_id, merchant_id, order_id)
  WHERE type='earn' AND loyalty_type='cashback' AND source='refund';
CREATE UNIQUE INDEX IF NOT EXISTS customer_orders_payment_id_unique
  ON public.customer_orders (payment_id) WHERE payment_id IS NOT NULL;

-- RPCs: add the idempotent topup branch (credit_customer_wallet) and order-level idempotency
-- (debit_customer_wallet), both insert-tx-first then move balance only if the tx was new.

-- Phase 3 — wallet RPC idempotency (audit H7 topup, M16 spend).
-- Insert-tx-first-then-move-balance so a duplicate call is a true no-op (mirrors the
-- existing refund branch). Never changes amounts, never adds a new deduct.

CREATE OR REPLACE FUNCTION public.credit_customer_wallet(p_customer_id uuid, p_merchant_id uuid, p_amount_halalas bigint, p_entry_type text, p_order_id text DEFAULT NULL::text, p_payment_id text DEFAULT NULL::text, p_complaint_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS TABLE(new_balance_halalas bigint, transaction_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_new_balance bigint;
  v_tx_id uuid;
begin
  if p_amount_halalas <= 0 then
    raise exception 'credit amount must be positive';
  end if;
  if p_entry_type not in ('topup', 'refund', 'adjustment') then
    raise exception 'invalid credit entry_type: %', p_entry_type;
  end if;

  -- Idempotent refund path.
  if p_entry_type = 'refund' and p_order_id is not null then
    insert into public.customer_wallet_transactions
      (customer_id, merchant_id, entry_type, amount_halalas, balance_after_halalas,
       order_id, payment_id, complaint_id, note)
    values
      (p_customer_id, p_merchant_id, 'refund', p_amount_halalas, 0,
       p_order_id, p_payment_id, p_complaint_id, p_note)
    on conflict (customer_id, merchant_id, order_id) where entry_type = 'refund'
      do nothing
    returning id into v_tx_id;

    if v_tx_id is null then
      -- already refunded for this order: return existing, credit nothing
      select id, balance_after_halalas into v_tx_id, v_new_balance
        from public.customer_wallet_transactions
        where customer_id = p_customer_id and merchant_id = p_merchant_id
          and order_id = p_order_id and entry_type = 'refund'
        order by created_at asc
        limit 1;
      return query select v_new_balance, v_tx_id;
      return;
    end if;

    insert into public.customer_wallet_balances as b (
      customer_id, merchant_id, balance_halalas, total_topup_halalas, total_refunded_halalas
    )
    values (p_customer_id, p_merchant_id, p_amount_halalas, 0, p_amount_halalas)
    on conflict (customer_id, merchant_id) do update set
      balance_halalas = b.balance_halalas + p_amount_halalas,
      total_refunded_halalas = b.total_refunded_halalas + p_amount_halalas,
      updated_at = now()
    returning b.balance_halalas into v_new_balance;

    update public.customer_wallet_transactions
      set balance_after_halalas = v_new_balance where id = v_tx_id;

    return query select v_new_balance, v_tx_id;
    return;
  end if;

  -- Idempotent top-up path (H7): insert the tx first under the partial unique
  -- index customer_wallet_tx_topup_per_payment; credit the balance ONLY if the
  -- insert was new. A duplicate /topup-finalize for one payment_id is a no-op.
  if p_entry_type = 'topup' and p_payment_id is not null then
    insert into public.customer_wallet_transactions
      (customer_id, merchant_id, entry_type, amount_halalas, balance_after_halalas,
       order_id, payment_id, complaint_id, note)
    values
      (p_customer_id, p_merchant_id, 'topup', p_amount_halalas, 0,
       p_order_id, p_payment_id, p_complaint_id, p_note)
    on conflict (customer_id, merchant_id, payment_id) where entry_type = 'topup'
      do nothing
    returning id into v_tx_id;

    if v_tx_id is null then
      -- already credited for this payment: return existing, credit nothing
      select id, balance_after_halalas into v_tx_id, v_new_balance
        from public.customer_wallet_transactions
        where customer_id = p_customer_id and merchant_id = p_merchant_id
          and payment_id = p_payment_id and entry_type = 'topup'
        order by created_at asc
        limit 1;
      return query select v_new_balance, v_tx_id;
      return;
    end if;

    insert into public.customer_wallet_balances as b (
      customer_id, merchant_id, balance_halalas, total_topup_halalas, total_refunded_halalas
    )
    values (p_customer_id, p_merchant_id, p_amount_halalas, p_amount_halalas, 0)
    on conflict (customer_id, merchant_id) do update set
      balance_halalas = b.balance_halalas + p_amount_halalas,
      total_topup_halalas = b.total_topup_halalas + p_amount_halalas,
      updated_at = now()
    returning b.balance_halalas into v_new_balance;

    update public.customer_wallet_transactions
      set balance_after_halalas = v_new_balance where id = v_tx_id;

    return query select v_new_balance, v_tx_id;
    return;
  end if;

  -- Original path: adjustment / topup-without-payment_id / refund-without-order_id (unchanged).
  insert into public.customer_wallet_balances as b (
    customer_id, merchant_id, balance_halalas,
    total_topup_halalas, total_refunded_halalas
  )
  values (
    p_customer_id, p_merchant_id, p_amount_halalas,
    case when p_entry_type = 'topup' then p_amount_halalas else 0 end,
    case when p_entry_type = 'refund' then p_amount_halalas else 0 end
  )
  on conflict (customer_id, merchant_id) do update set
    balance_halalas = b.balance_halalas + p_amount_halalas,
    total_topup_halalas = b.total_topup_halalas
      + case when p_entry_type = 'topup' then p_amount_halalas else 0 end,
    total_refunded_halalas = b.total_refunded_halalas
      + case when p_entry_type = 'refund' then p_amount_halalas else 0 end,
    updated_at = now()
  returning b.balance_halalas into v_new_balance;

  insert into public.customer_wallet_transactions
    (customer_id, merchant_id, entry_type, amount_halalas, balance_after_halalas,
     order_id, payment_id, complaint_id, note)
  values
    (p_customer_id, p_merchant_id, p_entry_type, p_amount_halalas, v_new_balance,
     p_order_id, p_payment_id, p_complaint_id, p_note)
  returning id into v_tx_id;

  return query select v_new_balance, v_tx_id;
end $function$;


CREATE OR REPLACE FUNCTION public.debit_customer_wallet(p_customer_id uuid, p_merchant_id uuid, p_amount_halalas bigint, p_order_id text, p_note text DEFAULT NULL::text)
 RETURNS TABLE(new_balance_halalas bigint, transaction_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_current bigint;
  v_new bigint;
  v_tx_id uuid;
begin
  if p_amount_halalas <= 0 then
    raise exception 'debit amount must be positive';
  end if;

  -- Lock the balance row (non-negative guard + serialize concurrent debits).
  select balance_halalas into v_current
    from public.customer_wallet_balances
    where customer_id = p_customer_id and merchant_id = p_merchant_id
    for update;

  -- Idempotency (M16): if this order already has a spend, return it, debit nothing.
  select id, balance_after_halalas into v_tx_id, v_new
    from public.customer_wallet_transactions
    where customer_id = p_customer_id and merchant_id = p_merchant_id
      and order_id = p_order_id and entry_type = 'spend'
    order by created_at asc
    limit 1;
  if v_tx_id is not null then
    return query select v_new, v_tx_id;
    return;
  end if;

  if v_current is null or v_current < p_amount_halalas then
    raise exception 'INSUFFICIENT_WALLET_BALANCE';
  end if;

  v_new := v_current - p_amount_halalas;

  -- Insert the spend tx first under the partial unique index
  -- customer_wallet_tx_spend_per_order; only move the balance if it was new.
  insert into public.customer_wallet_transactions
    (customer_id, merchant_id, entry_type, amount_halalas, balance_after_halalas,
     order_id, note)
  values
    (p_customer_id, p_merchant_id, 'spend', -p_amount_halalas, v_new, p_order_id, p_note)
  on conflict (customer_id, merchant_id, order_id) where entry_type = 'spend'
    do nothing
  returning id into v_tx_id;

  if v_tx_id is null then
    -- lost a concurrent race for this order: return the winner, debit nothing
    select id, balance_after_halalas into v_tx_id, v_new
      from public.customer_wallet_transactions
      where customer_id = p_customer_id and merchant_id = p_merchant_id
        and order_id = p_order_id and entry_type = 'spend'
      order by created_at asc
      limit 1;
    return query select v_new, v_tx_id;
    return;
  end if;

  update public.customer_wallet_balances
    set balance_halalas = v_new,
        total_spent_halalas = total_spent_halalas + p_amount_halalas,
        updated_at = now()
    where customer_id = p_customer_id and merchant_id = p_merchant_id;

  return query select v_new, v_tx_id;
end $function$;

-- ROLLBACK:
--   DROP INDEX IF EXISTS public.customer_wallet_tx_topup_per_payment;
--   DROP INDEX IF EXISTS public.customer_wallet_tx_spend_per_order;
--   DROP INDEX IF EXISTS public.loyalty_tx_cashback_restore_per_order;
--   DROP INDEX IF EXISTS public.customer_orders_payment_id_unique;
--   -- restore the prior credit_customer_wallet / debit_customer_wallet bodies from
--   -- scratchpad snapshot_* (pg_get_functiondef captured pre-change) or git history.
