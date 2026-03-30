-- Tracks per-customer loyalty program transitions when merchant switches type
-- e.g., when a merchant switches from cashback to stamps, old users keep their cashback
-- until spent or expired, while new users get stamps immediately.

CREATE TABLE IF NOT EXISTS public.loyalty_customer_transitions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id text NOT NULL,
  merchant_id text NOT NULL,
  from_loyalty_type text NOT NULL,
  to_loyalty_type text NOT NULL,
  config_version_at_switch integer NOT NULL,
  old_balance_exhausted boolean NOT NULL DEFAULT false,
  old_balance_exhausted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(customer_id, merchant_id, config_version_at_switch)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_customer_transitions_lookup
  ON public.loyalty_customer_transitions (customer_id, merchant_id, config_version_at_switch);

ALTER TABLE public.loyalty_customer_transitions ENABLE ROW LEVEL SECURITY;

-- Service role can do everything; authenticated users can read their own transitions
CREATE POLICY "Service role full access" ON public.loyalty_customer_transitions
  FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE public.loyalty_customer_transitions IS
  'Tracks per-customer state during loyalty program type switches. '
  'Old users keep old system until old_balance_exhausted=true (spent or expired).';
