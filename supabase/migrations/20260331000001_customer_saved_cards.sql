CREATE TABLE IF NOT EXISTS public.customer_saved_cards (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id text NOT NULL,
  merchant_id text NOT NULL,
  token text NOT NULL,
  brand text,
  last_four text,
  name text,
  expires_month integer,
  expires_year integer,
  created_at timestamptz DEFAULT now(),
  UNIQUE(customer_id, merchant_id, token)
);
ALTER TABLE public.customer_saved_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own cards" ON public.customer_saved_cards
  FOR SELECT USING (auth.uid()::text = customer_id);
CREATE POLICY "Users can delete own cards" ON public.customer_saved_cards
  FOR DELETE USING (auth.uid()::text = customer_id);
