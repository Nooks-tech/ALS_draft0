-- R9 fix — merchant-scoped storage bucket policies.
--
-- Pre-fix, both merchant-logos and complaint-photos bucket policies
-- only checked `auth.role() = 'authenticated'`. Any signed-in user
-- could upload to any path in those buckets — overwriting another
-- merchant's logo or polluting another customer's complaint folder.
-- App-layer routes that use the service-role key already enforce
-- merchant scoping (e.g. upload-logo writes to `${merchant_id}/...`),
-- so this migration tightens the underlying RLS to match — a defense
-- in depth against direct uploads bypassing the API.
--
-- Folder conventions (must match what the upload routes already use):
--   merchant-logos     →  ${merchant_id}/...
--   complaint-photos   →  ${order_id}/...
--
-- The promos bucket (nooksweb migration 20260513000001) is the
-- pattern these policies mirror.

-- ── merchant-logos: owner of the merchant in the first folder ──
DROP POLICY IF EXISTS "Authenticated users can upload merchant logos" ON storage.objects;
DROP POLICY IF EXISTS "Merchant owners can upload their logo" ON storage.objects;
CREATE POLICY "Merchant owners can upload their logo"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'merchant-logos'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.merchants WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Merchant owners can update their logo" ON storage.objects;
CREATE POLICY "Merchant owners can update their logo"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'merchant-logos'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.merchants WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Merchant owners can delete their logo" ON storage.objects;
CREATE POLICY "Merchant owners can delete their logo"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'merchant-logos'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.merchants WHERE user_id = auth.uid()
    )
  );

-- View stays public — logos are loaded on customer-facing surfaces.

-- ── complaint-photos: order owner only ──
-- Customer uploads to `${orderId}/${timestamp}-${rand}.${ext}` — the
-- first folder name is the customer_orders.id they're complaining
-- about. RLS checks that the auth user is the customer on that order.
-- Merchants don't upload here; their view of the complaint reads via
-- the dashboard API which uses the service-role key.
DROP POLICY IF EXISTS "Authenticated users can upload complaint photos" ON storage.objects;
DROP POLICY IF EXISTS "Order owners can upload complaint photos" ON storage.objects;
CREATE POLICY "Order owners can upload complaint photos"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'complaint-photos'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] IN (
      SELECT id FROM public.customer_orders WHERE customer_id = auth.uid()::text
    )
  );

DROP POLICY IF EXISTS "Order owners can delete complaint photos" ON storage.objects;
CREATE POLICY "Order owners can delete complaint photos"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'complaint-photos'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] IN (
      SELECT id FROM public.customer_orders WHERE customer_id = auth.uid()::text
    )
  );

-- View stays public — merchant dashboards and complaint-resolve flows
-- need to render the photos without burning auth tokens.
