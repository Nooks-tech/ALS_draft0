/**
 * Nooks public API – marketing banners (slider, popup, etc.).
 * GET {NOOKS_BASE}/api/public/merchants/{merchantId}/banners
 * Used in Offers tab and menu slider when Nooks Marketing Studio is available.
 * Returns [] when EXPO_PUBLIC_NOOKS_API_BASE_URL is not set or endpoint fails.
 */
import Constants from 'expo-constants';
import { Image } from 'react-native';
import { fetchWithTimeout } from '../lib/persistentCache';

const BASE_URL =
  Constants.expoConfig?.extra?.nooksApiBaseUrl ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  '';

export type BannerPlacement = 'slider' | 'popup' | 'offers';

export type NooksBanner = {
  id: string;
  image_url: string;
  title?: string;
  subtitle?: string;
  placement?: BannerPlacement;
  deep_link?: string; // Foodics category or product link
};

/**
 * Filters banners by prefetching each image + checking dimensions.
 * A banner is kept only if:
 *   1. Image.prefetch succeeds within 8s (downloaded + cached by OS)
 *   2. Image.getSize reports long side ≤ 2000 px (safe for phone decode)
 *
 * Anything that fails either check is dropped from the list. The
 * customer-facing surfaces (menu PromoSlider, popup queue, Offers tab)
 * therefore only ever see banners that won't freeze the JS thread.
 *
 * Critical: this lives in the shared API client so every caller
 * (warmup.ts, menu.tsx, offers.tsx) gets the same filtering. Before
 * this lived only in warmup.ts, but menu.tsx called fetchNooksBanners
 * directly and bypassed the filter — popups never went through
 * validation and could still freeze the app.
 */
const BANNER_MAX_DIMENSION = 2000;
const BANNER_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

async function isBannerImageSafe(url: string): Promise<boolean> {
  if (!url || typeof url !== 'string') return false;

  // Step 0: HEAD check for file size BEFORE downloading. Pre-empts the
  // download of huge images entirely — they never enter the OS cache,
  // never get decoded, can't freeze the JS thread. The HEAD request is
  // cheap (one round-trip, no body). If the server doesn't return
  // Content-Length (some CDNs strip it), we fall through to the
  // prefetch + getSize checks below as a backstop.
  try {
    const headController = new AbortController();
    const headTimeout = setTimeout(() => headController.abort(), 4000);
    try {
      const head = await fetch(url, { method: 'HEAD', signal: headController.signal });
      if (!head.ok) {
        console.warn('[Banners] HEAD non-ok, filtering:', head.status, url);
        return false;
      }
      const lenStr = head.headers.get('content-length');
      if (lenStr) {
        const len = Number(lenStr);
        if (Number.isFinite(len) && len > BANNER_MAX_BYTES) {
          console.warn('[Banners] File too large, filtering:', len, 'bytes:', url);
          return false;
        }
      }
    } finally {
      clearTimeout(headTimeout);
    }
  } catch (e) {
    console.warn('[Banners] HEAD failed, filtering:', (e as Error)?.message, url);
    return false;
  }

  // Step 1: prefetch (warm OS cache + verify decodability).
  let prefetchTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let prefetchOk = false;
  try {
    prefetchOk = await Promise.race<boolean>([
      Image.prefetch(url).then(Boolean),
      new Promise<boolean>((resolve) => {
        prefetchTimeoutId = setTimeout(() => resolve(false), 8000);
      }),
    ]);
  } catch {
    prefetchOk = false;
  } finally {
    if (prefetchTimeoutId !== null) clearTimeout(prefetchTimeoutId);
  }
  if (!prefetchOk) {
    console.warn('[Banners] Prefetch failed/timeout, filtering:', url);
    return false;
  }

  // Step 2: dimensions. getSize uses the cached file. Defensive against
  // small file size but huge pixel dimensions (highly-compressed PNG).
  let sizeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const dims = await Promise.race<{ width: number; height: number } | null>([
      new Promise<{ width: number; height: number } | null>((resolve) => {
        Image.getSize(
          url,
          (width, height) => resolve({ width, height }),
          () => resolve(null),
        );
      }),
      new Promise<null>((resolve) => {
        sizeTimeoutId = setTimeout(() => resolve(null), 4000);
      }),
    ]);
    if (!dims) {
      console.warn('[Banners] getSize failed, filtering:', url);
      return false;
    }
    const longSide = Math.max(dims.width, dims.height);
    if (longSide > BANNER_MAX_DIMENSION) {
      console.warn('[Banners] Dimensions too large, filtering:', url, `${dims.width}x${dims.height}`);
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (sizeTimeoutId !== null) clearTimeout(sizeTimeoutId);
  }
}

export async function fetchNooksBanners(merchantId: string): Promise<NooksBanner[]> {
  if (!BASE_URL.trim() || !merchantId.trim()) return [];
  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/merchants/${encodeURIComponent(merchantId)}/banners`;
  let raw: NooksBanner[] = [];
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];
    const data = (await res.json()) as NooksBanner[] | { banners?: NooksBanner[] };
    if (Array.isArray(data)) raw = data;
    else if (data && Array.isArray((data as { banners?: NooksBanner[] }).banners)) {
      raw = (data as { banners: NooksBanner[] }).banners;
    }
  } catch {
    return [];
  }

  // Filter to safe-to-decode banners. Parallel checks since the
  // bottleneck is per-image network/decode, not server pressure.
  const results = await Promise.all(
    raw.map(async (banner) => ({ banner, ok: await isBannerImageSafe(banner.image_url) })),
  );
  return results.filter((r) => r.ok).map((r) => r.banner);
}
