/**
 * Complaint photos live in the private `complaint-photos` Supabase Storage
 * bucket (PDPL — customer complaint photos must not be public; made
 * private by migration 20260724120000). Rows written before that
 * migration store a full public URL
 * (…/storage/v1/object/public/complaint-photos/<path>); rows written
 * after store just the bucket-relative path. Every read path must
 * normalize either shape down to a path and ask Storage for a
 * short-lived signed URL — the API must never hand a client a permanent
 * public link again.
 */

export const COMPLAINT_PHOTOS_BUCKET = 'complaint-photos';
export const COMPLAINT_PHOTO_SIGNED_URL_TTL_SECONDS = 3600;

const PUBLIC_URL_MARKER = '/object/public/complaint-photos/';

/** Normalize a legacy public URL or an already-relative path down to the bucket-relative storage path. */
export function complaintPhotoStoragePath(value: string): string {
  const idx = value.indexOf(PUBLIC_URL_MARKER);
  if (idx === -1) return value;
  const rawPath = value.slice(idx + PUBLIC_URL_MARKER.length);
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

export type SignedUrlBatchResult = { path: string | null; signedUrl?: string | null; error?: string | null };
export type CreateSignedUrls = (
  paths: string[],
  expiresInSeconds: number,
) => Promise<{ data: SignedUrlBatchResult[] | null; error: unknown }>;

/**
 * Convert stored complaint photo references (legacy public URLs or
 * bucket-relative paths) into short-lived signed URLs safe to hand to a
 * client. Entries that fail to sign (e.g. the object was since deleted)
 * are dropped rather than surfaced as broken links.
 */
export async function signComplaintPhotoUrls(
  photoUrls: string[] | null | undefined,
  createSignedUrls: CreateSignedUrls,
): Promise<string[]> {
  const paths = (photoUrls ?? []).filter((u): u is string => !!u).map(complaintPhotoStoragePath);
  if (paths.length === 0) return [];
  const { data, error } = await createSignedUrls(paths, COMPLAINT_PHOTO_SIGNED_URL_TTL_SECONDS);
  if (error || !data) return [];
  return data.filter((d) => !d.error && d.signedUrl).map((d) => d.signedUrl as string);
}
