-- Payment-orphan candidate queue: the "charged, no order row" money-safety gap.
--
-- WHY: Apple Pay / saved-card checkout captures the card CLIENT-SIDE before
-- POST /api/orders/commit is ever sent (app/checkout.tsx fires commitOrder()
-- only AFTER the Moyasar SDK reports PaymentStatus.paid). If the app crashes,
-- the network drops, or the user kills the app in the window between the
-- Apple Pay sheet completing and the commit request landing, NO SERVER CODE
-- RUNS AT ALL — the customer is charged and no public.customer_orders row is
-- ever created. Confirmed 2026-07-16: 3 such captures happened in one night
-- and nothing refunded them.
--
-- Every existing sweep/reconciliation job in both repos (ALS
-- /internal/sweep-abandoned-payments, paymentProcessingHealth,
-- savedCardSweep; nooksweb reconcile-payment-processing,
-- reconcile-web-orders) filters on an EXISTING customer_orders row. A
-- payment whose order row never landed is invisible to all of them —
-- invisible forever, not just until the next sweep.
--
-- nooksweb's Moyasar webhook (app/api/webhooks/moyasar/route.ts,
-- accruePlatformFee's orphan branch) is the one place that reliably learns
-- "Moyasar says this payment is paid" independently of the commit flow —
-- it already retries the customer_orders lookup once (2.5s) before giving
-- up. Previously, on a persistent miss, it ONLY wrote an audit_log row
-- about the platform's own lost 1 SAR fee (moyasar.platform_fee_orphan) —
-- it took no action for the CUSTOMER's money.
--
-- DESIGN CONSTRAINT: the webhook must never refund inline. "Paid with no
-- order row" is the NORMAL transient state of every healthy Apple Pay
-- order, because payment precedes commit by design (the commit request is
-- typically already on the wire, or the SCAL-003 settling retry is still
-- running — see server/utils/paymentSettling.ts). Refunding inline would
-- refund healthy in-flight orders mid-flight. So the webhook only RECORDS a
-- candidate here; a separate ALS cron (paymentOrphanSweep) reverses it only
-- after a grace window comfortably longer than any legitimate settling path
-- has elapsed. See server/cron/paymentOrphanSweep.ts for the sweep + the
-- strict-binding reversal (reverseStrictlyBoundRejectedPayment).
--
-- payment_id is the PRIMARY KEY (not a surrogate id): Moyasar webhooks fire
-- repeatedly for the same payment (retries, paid/captured near-duplicates),
-- so ON CONFLICT (payment_id) DO NOTHING is the natural idempotency guard —
-- and critically, DO NOTHING means a repeating webhook can NEVER push
-- first_seen_at forward and re-extend the grace window past what the first
-- sighting already started.
--
-- RLS/grants follow the Phase C/D convention corrected 2026-07-15 (F21):
-- this project's service_role does NOT have BYPASSRLS, so RLS-enabled
-- tables need an explicit service_role policy or service_role silently
-- reads/writes zero rows. Belt-and-suspenders: RLS + an explicit
-- service_role-only policy, PLUS table-level REVOKE/GRANT so anon and
-- authenticated have no path in even if RLS were ever misconfigured or
-- disabled. Nothing here is ever readable/writable by anon or authenticated.

CREATE TABLE public.payment_orphan_candidates (
  payment_id          text PRIMARY KEY,
  merchant_id         text NOT NULL,
  amount_halalas      bigint NOT NULL CHECK (amount_halalas > 0),
  metadata_order_id    text,
  metadata_customer_id text,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  resolution          text CHECK (
    resolution IS NULL OR resolution IN ('order_found', 'reversed', 'manual_review', 'not_paid')
  ),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error          text,
  -- 'manual_review' is deliberately NOT a terminal state: it can mean a
  -- transient provider ambiguity (Moyasar 429/5xx mid-cancel) that should
  -- self-heal on a later sweep pass, not just a conclusively-stuck case. So
  -- resolved_at stays NULL while resolution='manual_review' — the row is
  -- still picked up by WHERE resolved_at IS NULL and retried (attempts
  -- keeps climbing, last_error keeps getting freshened, a human can also
  -- act from the audit_log trail). Only 'order_found' / 'reversed' /
  -- 'not_paid' close the row for good.
  CONSTRAINT payment_orphan_candidates_resolution_shape CHECK (
    (resolved_at IS NULL AND resolution IS NULL)
    OR (resolved_at IS NULL AND resolution = 'manual_review')
    OR (resolved_at IS NOT NULL AND resolution IN ('order_found', 'reversed', 'not_paid'))
  )
);

-- Sweep query shape: WHERE resolved_at IS NULL AND first_seen_at < cutoff
-- ORDER BY first_seen_at. Partial on the unresolved predicate so the index
-- never grows with the (unbounded, append-only) history of already-resolved
-- rows — only the live queue is indexed.
CREATE INDEX payment_orphan_candidates_unresolved_idx
  ON public.payment_orphan_candidates (resolved_at, first_seen_at)
  WHERE resolved_at IS NULL;

ALTER TABLE public.payment_orphan_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON public.payment_orphan_candidates;
CREATE POLICY "service_role_all" ON public.payment_orphan_candidates
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.payment_orphan_candidates FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_orphan_candidates TO service_role;

-- ROLLBACK: DROP TABLE IF EXISTS public.payment_orphan_candidates;
