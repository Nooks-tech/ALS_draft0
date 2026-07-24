-- PDPL fix — the complaint-photos bucket was public, so anyone with the
-- URL (customer_id-derived path, easily guessable/enumerable) could view
-- another customer's complaint photos with no auth. Make the bucket
-- private; app code now serves photos via short-lived signed URLs
-- (see server/utils/complaintPhotos.ts) instead of permanent public
-- links.

BEGIN;

UPDATE storage.buckets SET public = false WHERE id = 'complaint-photos';

COMMIT;

-- ROLLBACK:
-- UPDATE storage.buckets SET public = true WHERE id = 'complaint-photos';
