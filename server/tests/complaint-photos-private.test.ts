import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { complaintPhotoStoragePath, signComplaintPhotoUrls } from '../utils/complaintPhotos';

test('complaintPhotoStoragePath passes an already-relative path through unchanged', () => {
  assert.equal(
    complaintPhotoStoragePath('complaints/user-123/photo.jpg'),
    'complaints/user-123/photo.jpg',
  );
});

test('complaintPhotoStoragePath extracts the relative path from a legacy public URL', () => {
  const legacy =
    'https://abcxyz.supabase.co/storage/v1/object/public/complaint-photos/complaints/user-123/photo.jpg';
  assert.equal(complaintPhotoStoragePath(legacy), 'complaints/user-123/photo.jpg');
});

test('complaintPhotoStoragePath decodes URL-escaped characters in the extracted path', () => {
  const legacy =
    'https://abcxyz.supabase.co/storage/v1/object/public/complaint-photos/complaints/user-123/my%20photo.jpg';
  assert.equal(complaintPhotoStoragePath(legacy), 'complaints/user-123/my photo.jpg');
});

test('signComplaintPhotoUrls returns [] for empty/null/undefined input without calling Storage', async () => {
  let called = false;
  const createSignedUrls = async () => {
    called = true;
    return { data: [], error: null };
  };
  assert.deepEqual(await signComplaintPhotoUrls([], createSignedUrls), []);
  assert.deepEqual(await signComplaintPhotoUrls(null, createSignedUrls), []);
  assert.deepEqual(await signComplaintPhotoUrls(undefined, createSignedUrls), []);
  assert.equal(called, false);
});

test('signComplaintPhotoUrls normalizes legacy public URLs before requesting signed URLs', async () => {
  const requestedPaths: string[][] = [];
  const createSignedUrls = async (paths: string[], expiresIn: number) => {
    requestedPaths.push(paths);
    assert.equal(expiresIn, 3600);
    return {
      data: paths.map((p) => ({ path: p, signedUrl: `https://signed.example/${p}?token=abc`, error: null })),
      error: null,
    };
  };

  const result = await signComplaintPhotoUrls(
    [
      'https://abcxyz.supabase.co/storage/v1/object/public/complaint-photos/complaints/u1/a.jpg',
      'complaints/u1/b.jpg',
    ],
    createSignedUrls,
  );

  assert.deepEqual(requestedPaths, [['complaints/u1/a.jpg', 'complaints/u1/b.jpg']]);
  assert.deepEqual(result, [
    'https://signed.example/complaints/u1/a.jpg?token=abc',
    'https://signed.example/complaints/u1/b.jpg?token=abc',
  ]);
});

test('signComplaintPhotoUrls drops entries that failed to sign instead of returning broken links', async () => {
  const createSignedUrls = async (paths: string[]) => ({
    data: paths.map((p, i) =>
      i === 0
        ? { path: p, signedUrl: `https://signed.example/${p}`, error: null }
        : { path: p, signedUrl: null, error: 'Object not found' },
    ),
    error: null,
  });

  const result = await signComplaintPhotoUrls(['complaints/u1/ok.jpg', 'complaints/u1/deleted.jpg'], createSignedUrls);
  assert.deepEqual(result, ['https://signed.example/complaints/u1/ok.jpg']);
});

test('signComplaintPhotoUrls returns [] when the Storage call itself errors', async () => {
  const createSignedUrls = async () => ({ data: null, error: { message: 'boom' } });
  const result = await signComplaintPhotoUrls(['complaints/u1/a.jpg'], createSignedUrls);
  assert.deepEqual(result, []);
});

// Complaint status pushes are transactional (order-outcome notifications),
// not marketing — they must stay on the 'orders' channel regardless of
// whatever opt-in filter the marketing channel gets. Source-scan guard so a
// future edit can't silently regress this back to 'marketing'.
test('complaint status pushes use the transactional "orders" channel, not "marketing"', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/complaints.ts'), 'utf8');
  const channelValues = [...source.matchAll(/channel:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(channelValues.length >= 2, 'expected at least 2 sendPushScoped channel values in complaints.ts');
  for (const value of channelValues) {
    assert.equal(value, 'orders', `expected complaint push channel to be 'orders', got '${value}'`);
  }
});
