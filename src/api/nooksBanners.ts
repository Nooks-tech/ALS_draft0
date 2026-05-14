/**
 * Nooks public API – marketing banners (slider, popup, etc.).
 * GET {NOOKS_BASE}/api/public/merchants/{merchantId}/banners
 * Used in Offers tab and menu slider when Nooks Marketing Studio is available.
 * Returns [] when EXPO_PUBLIC_NOOKS_API_BASE_URL is not set or endpoint fails.
 */
import Constants from 'expo-constants';
import { Image } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
const BANNER_SAFE_CACHE_PREFIX = '@als_banner_ok::';

/**
 * Fire-and-forget debug POST so we can see on the SERVER which
 * banner validations are passing/failing for each device. Goes to
 * nooksweb's /api/public/debug/banner-check route which just logs
 * the body. Doesn't await — never slows down the actual validation
 * pipeline. If the network is dead we silently drop.
 */
function logBannerCheck(payload: Record<string, unknown>): void {
  if (!BASE_URL.trim()) return;
  const url = `${BASE_URL.replace(/\/$/, '')}/api/public/debug/banner-check`;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, ts: Date.now() }),
  }).catch(() => {
    // best effort
  });
}

/**
 * Per-URL validation cache. Once a banner URL has been verified safe
 * for this device, we never re-validate it. This is critical for
 * deterministic popup ordering: previously, validation ran on every
 * cold launch, and a flaky network on one launch could cause banner
 * #2 to fail (timeout) while banner #3 passed — the popup queue then
 * showed #3 first, then #2 on the next launch when network was fine.
 * User saw popups in random order instead of sort_order.
 *
 * Caching only SUCCESS (not failure) means a banner that failed once
 * gets retried on the next launch. If it consistently fails, it
 * continues to be filtered. If it intermittently fails, it eventually
 * passes and gets cached as safe. After 1-2 cold starts, all banners
 * are typically cached and the queue is fully deterministic.
 *
 * Cache key is the full URL string. Supabase Storage paths include
 * `${merchantId}/banner-${Date.now()}.png` so a re-upload changes the
 * URL automatically — no stale-cache risk after the merchant
 * re-normalizes.
 */
async function isBannerImageSafe(url: string, ctx: { merchantId: string; bannerId?: string } = { merchantId: '' }): Promise<boolean> {
  const startedAt = Date.now();
  if (!url || typeof url !== 'string') {
    logBannerCheck({ ...ctx, url, ok: false, reason: 'empty_url' });
    return false;
  }

  // Cache hit? Trust the previous validation.
  try {
    const cached = await AsyncStorage.getItem(BANNER_SAFE_CACHE_PREFIX + url);
    if (cached === '1') {
      logBannerCheck({ ...ctx, url, ok: true, reason: 'cache_hit', durationMs: Date.now() - startedAt });
      return true;
    }
  } catch {
    // Cache read failure is non-fatal; fall through to live validation.
  }

  // Step 0: HEAD check for file size BEFORE downloading.
  let headStatus: number | null = null;
  let contentLength: number | null = null;
  try {
    const headController = new AbortController();
    const headTimeout = setTimeout(() => headController.abort(), 4000);
    try {
      const head = await fetch(url, { method: 'HEAD', signal: headController.signal });
      headStatus = head.status;
      if (!head.ok) {
        console.warn('[Banners] HEAD non-ok, filtering:', head.status, url);
        logBannerCheck({ ...ctx, url, ok: false, reason: 'head_non_ok', headStatus, durationMs: Date.now() - startedAt });
        return false;
      }
      const lenStr = head.headers.get('content-length');
      if (lenStr) {
        const len = Number(lenStr);
        contentLength = Number.isFinite(len) ? len : null;
        if (Number.isFinite(len) && len > BANNER_MAX_BYTES) {
          console.warn('[Banners] File too large, filtering:', len, 'bytes:', url);
          logBannerCheck({ ...ctx, url, ok: false, reason: 'too_large', contentLength: len, maxBytes: BANNER_MAX_BYTES, durationMs: Date.now() - startedAt });
          return false;
        }
      }
    } finally {
      clearTimeout(headTimeout);
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? 'unknown';
    console.warn('[Banners] HEAD failed, filtering:', msg, url);
    logBannerCheck({ ...ctx, url, ok: false, reason: 'head_threw', errorMessage: msg, durationMs: Date.now() - startedAt });
    return false;
  }

  // Step 1: prefetch.
  let prefetchTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let prefetchOk = false;
  const prefetchStartedAt = Date.now();
  try {
    prefetchOk = await Promise.race<boolean>([
      Image.prefetch(url).then(Boolean),
      new Promise<boolean>((resolve) => {
        prefetchTimeoutId = setTimeout(() => resolve(false), 15000);
      }),
    ]);
  } catch {
    prefetchOk = false;
  } finally {
    if (prefetchTimeoutId !== null) clearTimeout(prefetchTimeoutId);
  }
  const prefetchMs = Date.now() - prefetchStartedAt;
  if (!prefetchOk) {
    console.warn('[Banners] Prefetch failed/timeout, filtering:', url);
    logBannerCheck({ ...ctx, url, ok: false, reason: 'prefetch_failed', prefetchMs, headStatus, contentLength, durationMs: Date.now() - startedAt });
    return false;
  }

  // Step 2: dimensions check.
  let sizeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let dimsOk = false;
  let dimsW: number | null = null;
  let dimsH: number | null = null;
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
        sizeTimeoutId = setTimeout(() => resolve(null), 5000);
      }),
    ]);
    if (!dims) {
      console.warn('[Banners] getSize failed, filtering:', url);
      logBannerCheck({ ...ctx, url, ok: false, reason: 'getsize_failed', prefetchMs, headStatus, contentLength, durationMs: Date.now() - startedAt });
      return false;
    }
    dimsW = dims.width;
    dimsH = dims.height;
    const longSide = Math.max(dims.width, dims.height);
    if (longSide > BANNER_MAX_DIMENSION) {
      console.warn('[Banners] Dimensions too large, filtering:', url, `${dims.width}x${dims.height}`);
      logBannerCheck({ ...ctx, url, ok: false, reason: 'dims_too_large', dimsW, dimsH, maxDim: BANNER_MAX_DIMENSION, prefetchMs, headStatus, contentLength, durationMs: Date.now() - startedAt });
      return false;
    }
    dimsOk = true;
  } catch {
    logBannerCheck({ ...ctx, url, ok: false, reason: 'getsize_threw', prefetchMs, headStatus, contentLength, durationMs: Date.now() - startedAt });
    return false;
  } finally {
    if (sizeTimeoutId !== null) clearTimeout(sizeTimeoutId);
  }

  // Cache success so we never re-validate this URL on this device.
  if (dimsOk) {
    try {
      await AsyncStorage.setItem(BANNER_SAFE_CACHE_PREFIX + url, '1');
    } catch {
      // best effort
    }
    logBannerCheck({ ...ctx, url, ok: true, reason: 'validated', dimsW, dimsH, prefetchMs, headStatus, contentLength, durationMs: Date.now() - startedAt });
  }
  return dimsOk;
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
  // Pass merchant + banner ids so debug logs can correlate.
  const results = await Promise.all(
    raw.map(async (banner) => ({
      banner,
      ok: await isBannerImageSafe(banner.image_url, { merchantId, bannerId: banner.id }),
    })),
  );
  // Also log the final filter outcome per merchant so we can see at a
  // glance which banners were kept vs dropped on this device.
  logBannerCheck({
    merchantId,
    url: '_summary',
    ok: true,
    reason: 'fetch_summary',
    rawCount: raw.length,
    keptCount: results.filter((r) => r.ok).length,
    droppedCount: results.filter((r) => !r.ok).length,
    keptIds: results.filter((r) => r.ok).map((r) => r.banner.id),
    droppedIds: results.filter((r) => !r.ok).map((r) => r.banner.id),
  });
  return results.filter((r) => r.ok).map((r) => r.banner);
}
