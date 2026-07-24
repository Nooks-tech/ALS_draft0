import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const complaintsRouteSource = fs.readFileSync(path.join(__dirname, '../routes/complaints.ts'), 'utf8');
const migrationSource = fs.readFileSync(
  path.join(__dirname, '../../supabase/migrations/20260724140000_complaint_photos_rls.sql'),
  'utf8',
);
const legacyMigrationSource = fs.readFileSync(
  path.join(__dirname, '../../supabase/migrations/20260308000000_refunds_complaints.sql'),
  'utf8',
);
const orderDetailModalSource = fs.readFileSync(
  path.join(__dirname, '../../app/order-detail-modal.tsx'),
  'utf8',
);
const ordersApiSource = fs.readFileSync(path.join(__dirname, '../../src/api/orders.ts'), 'utf8');

test('POST /upload signs and returns a previewUrl for the object it just uploaded', () => {
  const uploadStart = complaintsRouteSource.indexOf("complaintsRouter.post('/upload'");
  assert.ok(uploadStart >= 0, 'expected POST /upload handler in complaints.ts');
  const uploadSource = complaintsRouteSource.slice(uploadStart);

  // The signed URL must be generated with the service-role client
  // (supabaseAdmin) AFTER the upload succeeds, using the same storage
  // path that was just written to.
  const uploadCallIndex = uploadSource.indexOf('.upload(storagePath');
  const signCallIndex = uploadSource.indexOf('.createSignedUrl(storagePath');
  const responseIndex = uploadSource.indexOf('res.json({ path: storagePath, previewUrl:');
  assert.ok(uploadCallIndex >= 0, 'expected the storage .upload(storagePath, ...) call');
  assert.ok(signCallIndex >= 0, 'expected a .createSignedUrl(storagePath, ...) call');
  assert.ok(responseIndex >= 0, 'expected the response to include previewUrl');
  assert.ok(signCallIndex > uploadCallIndex, 'signing must happen after the upload succeeds');
  assert.ok(responseIndex > signCallIndex, 'previewUrl must be returned after it is signed');

  // Signed with the service-role client, not any client-supplied key.
  assert.match(uploadSource, /supabaseAdmin\.storage\s*\n?\s*\.from\(COMPLAINT_PHOTOS_BUCKET\)\s*\n?\s*\.createSignedUrl\(storagePath/);
});

test('the unrestricted "Anyone can view complaint photos" SELECT policy is dropped by name', () => {
  assert.match(
    migrationSource,
    /DROP POLICY IF EXISTS "Anyone can view complaint photos" ON storage\.objects;/,
  );
  // No replacement client-facing SELECT policy for this bucket — reads
  // are server-only (service-role) from here on. Strip SQL comment lines
  // first so a commented-out ROLLBACK snippet doesn't trip this check.
  const activeSql = migrationSource
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert.doesNotMatch(
    activeSql,
    /CREATE POLICY[\s\S]*?ON storage\.objects FOR SELECT[\s\S]*?complaint-photos/,
  );
});

test('the dropped policy name matches exactly what the original migration created', () => {
  // Guards against a future rename in either file silently breaking the
  // DROP (DROP POLICY IF EXISTS on the wrong name is a silent no-op).
  assert.match(
    legacyMigrationSource,
    /CREATE POLICY "Anyone can view complaint photos"\s*\n\s*ON storage\.objects FOR SELECT\s*\n\s*USING \(bucket_id = 'complaint-photos'\);/,
  );
});

test('the migration explains why service-role and nooksweb reads are unaffected', () => {
  assert.match(migrationSource, /service-role/i);
  assert.match(migrationSource, /nooksweb/i);
});

test('order-detail-modal.tsx no longer calls supabase.storage against complaint-photos', () => {
  assert.doesNotMatch(orderDetailModalSource, /supabase\.storage[\s\S]{0,80}complaint-photos/);
  assert.doesNotMatch(orderDetailModalSource, /\.createSignedUrl\(/);
  // It must consume the server-issued previewUrl instead.
  assert.match(orderDetailModalSource, /previewUrl/);
});

test('src/api/orders.ts no longer client-signs complaint photo URLs', () => {
  assert.doesNotMatch(ordersApiSource, /\.createSignedUrl/);
  assert.doesNotMatch(ordersApiSource, /supabase\.storage[\s\S]{0,80}complaint-photos/);
});
