-- PDPL fix — closing the hole left open by 20260724120000.
--
-- 20260724120000_complaint_photos_private.sql made the complaint-photos
-- bucket private, but that alone did nothing: a PRE-EXISTING, unrestricted
-- SELECT policy on storage.objects — "Anyone can view complaint photos"
-- (created in 20260308000000_refunds_complaints.sql, re-created verbatim
-- in 20260312000000_full_system_migration.sql) — has no owner check at
-- all:
--
--   CREATE POLICY "Anyone can view complaint photos"
--     ON storage.objects FOR SELECT
--     USING (bucket_id = 'complaint-photos');
--
-- That policy is the RLS gate for signed-URL generation. Any authenticated
-- client (any customer, or a merchant, using only the anon key + their own
-- JWT) could call
-- supabase.storage.from('complaint-photos').createSignedUrl(<any path>)
-- and read ANY other customer's complaint photos — a direct PDPL
-- cross-customer exposure. app/order-detail-modal.tsx and
-- src/api/orders.ts previously relied on exactly this to sign preview /
-- read URLs client-side; both were changed (same remediation round) to
-- stop doing that.
--
-- Fix: drop the policy by name. No replacement client-facing SELECT
-- policy is added — reads now go exclusively through the server, using
-- the service-role key (which bypasses RLS entirely), via
-- server/routes/complaints.ts + server/utils/complaintPhotos.ts.
--
-- A single DROP BY NAME covers both the original CREATE (20260308) and
-- the re-CREATE (20260312) — same policy name means there was only ever
-- one live policy row.
--
-- Service-role reads are UNAFFECTED by dropping this policy — RLS is
-- bypassed for the service-role key regardless of which policies exist.
-- The merchant dashboard (nooksweb) reads complaint photos via its own
-- service-role client too, so it needs no change here.
--
-- INSERT/DELETE policies from
-- 20260521000000_storage_bucket_merchant_scoping.sql ("Order owners can
-- upload/delete complaint photos", owner-scoped by order folder) are left
-- untouched — customers still upload their own complaint photos directly.

BEGIN;

DROP POLICY IF EXISTS "Anyone can view complaint photos" ON storage.objects;

COMMIT;

-- ROLLBACK (re-opens the cross-customer read hole — do not use in prod):
-- CREATE POLICY "Anyone can view complaint photos"
--   ON storage.objects FOR SELECT
--   USING (bucket_id = 'complaint-photos');
