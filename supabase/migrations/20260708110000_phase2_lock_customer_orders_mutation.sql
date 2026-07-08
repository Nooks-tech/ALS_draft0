-- Phase 2 — lock down customer_orders mutation to service_role (audit 2026-07-07: H3, M2)
-- Applied to live DB (setynlgmdzaceegrlgwg) 2026-07-08; this file is the version-controlled record.
--
-- H3/M2: authenticated customers could PATCH/INSERT their own customer_orders rows
-- (policies scoped only by customer_id, no column/merchant constraint) — the lever for
-- unbounded loyalty inflation (inflate total_sar / fabricate a Ready order, then trigger earn).
--
-- Pre-check (blocking gate) result: the only client-side customer_orders write is
-- insertOrder() at src/api/orders.ts:293 (called from OrdersContext.tsx:434), which is
-- UNREACHABLE dead code — it needs !serverPersisted && customerId, but serverPersisted =
-- Boolean(user.id) and customerId = user.id are the same value, so the conditions are
-- mutually exclusive; and a submitOrderToNooks() server fallback sits behind it. No client
-- UPDATE path exists. Server order creation/mutation uses supabaseAdmin (service_role),
-- unaffected. Verified after apply: anon PATCH wrote 0 rows; a real order was unchanged.

DROP POLICY IF EXISTS "Users can insert own orders" ON public.customer_orders;
DROP POLICY IF EXISTS "customer_orders_insert_own" ON public.customer_orders;
DROP POLICY IF EXISTS "customer_orders_update_own" ON public.customer_orders;

-- Kept: "Users can select own orders", "customer_orders_select_own" (SELECT-own so the app
-- reads its orders), "service role full access customer_orders" (server writes).

-- ROLLBACK (recreate from Phase 0 snapshot):
--   CREATE POLICY "Users can insert own orders" ON public.customer_orders
--     FOR INSERT TO public WITH CHECK ((auth.uid())::text = customer_id);
--   CREATE POLICY "customer_orders_insert_own" ON public.customer_orders
--     FOR INSERT TO public WITH CHECK (((auth.uid())::text = customer_id) OR (auth.role() = 'service_role'::text));
--   CREATE POLICY "customer_orders_update_own" ON public.customer_orders
--     FOR UPDATE TO public
--     USING (((auth.uid())::text = customer_id) OR (auth.role() = 'service_role'::text))
--     WITH CHECK (((auth.uid())::text = customer_id) OR (auth.role() = 'service_role'::text));
