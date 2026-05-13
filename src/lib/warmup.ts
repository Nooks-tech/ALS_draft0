/**
 * Background warmup coordinator.
 *
 * The customer's hot path is: launch → splash (2 - 4 s) → menu tab.
 * Most other tabs (offers, loyalty, checkout, orders) are visited
 * AFTER the menu, often a minute or more later. That window is dead
 * time we can use to prefetch every non-menu payload into AsyncStorage
 * via the same cache keys those screens already read on mount.
 * Net effect: when the customer eventually taps Offers / Checkout /
 * Apple Wallet, the screen paints with cached data on the first frame
 * and the visible network roundtrip is gone.
 *
 * Each warmup-* function:
 *   - Skips itself if its precondition isn't met (e.g. iOS-only for
 *     Apple Wallet, or no auth for customer-scoped fetches).
 *   - Wraps its own try/catch so a transient failure on one payload
 *     never blocks the rest of the warmup chain.
 *   - Writes to the EXACT same cache key the consumer reads from, so
 *     no consumer code changes are needed for the prefetched data
 *     to take effect.
 *
 * Fire-and-forget: callers use `void runWarmup(...)` from a useEffect.
 * No blocking, no UI dependency, no Promise propagation.
 */
import { Platform } from 'react-native';
import { fetchNooksBanners, type NooksBanner } from '../api/nooksBanners';
import { fetchNooksPromos, type NooksPromo } from '../api/nooksPromos';
import { loyaltyApi, type LoyaltyBalance, type LoyaltyReward, type LoyaltyTransaction } from '../api/loyalty';
import { walletApi } from '../api/wallet';
import { paymentApi, type SavedCard } from '../api/payment';
import { API_URL } from '../api/config';
import { getAuthToken } from '../api/client';
import { readCache, writeCache, fetchWithTimeout } from './persistentCache';

export type WarmupContext = {
  userId: string | null;
  merchantId: string;
  /** Has the customer already added the Apple Wallet pass once?
   *  When true we skip prefetching since the offers screen already
   *  hides the Add button. Persisted at apple_pass_added::{m}::{u}. */
  applePassAlreadyAdded: boolean;
};

/* ─── Offers tab (banners + promos) ──────────────────────────────── */

async function warmupOffers(merchantId: string): Promise<void> {
  if (!merchantId) return;
  const cacheKey = `@als_offers_${merchantId}`;
  type OffersCache = { banners: NooksBanner[]; promos: NooksPromo[] };
  try {
    // fetchNooksBanners now filters internally (prefetch + Image.getSize
    // dimension check) — see src/api/nooksBanners.ts. Returns only
    // banners that are safe to render on the customer's phone.
    const [banners, promos] = await Promise.all([
      fetchNooksBanners(merchantId),
      fetchNooksPromos(merchantId),
    ]);
    await writeCache<OffersCache>(cacheKey, { banners, promos });
  } catch {
    // best effort
  }
}

/* ─── Loyalty (balance + rewards + history) ──────────────────────── */

async function warmupLoyalty(userId: string, merchantId: string): Promise<void> {
  if (!userId || !merchantId) return;
  const cacheKey = `@als_loyalty_${merchantId}_${userId}`;
  type LoyaltyCache = {
    balance: LoyaltyBalance | null;
    transactions: LoyaltyTransaction[];
    rewards: LoyaltyReward[];
  };
  try {
    const [bal, hist, rw] = await Promise.all([
      loyaltyApi.getBalance(userId, merchantId).catch(() => null),
      loyaltyApi.getHistory(userId, merchantId).catch(() => ({ transactions: [] as LoyaltyTransaction[] })),
      loyaltyApi.getRewards(merchantId).catch(() => ({ rewards: [] as LoyaltyReward[] })),
    ]);
    await writeCache<LoyaltyCache>(cacheKey, {
      balance: bal,
      transactions: hist?.transactions ?? [],
      rewards: rw?.rewards ?? [],
    });
    // Also seed the checkout-scoped balance cache so the
    // /checkout screen finds it under its own key.
    if (bal) {
      await writeCache<LoyaltyBalance>(`@als_loyalty_balance_${merchantId}_${userId}`, bal);
    }
  } catch {
    // best effort
  }
}

/* ─── Wallet credit ──────────────────────────────────────────────── */

async function warmupWallet(userId: string, merchantId: string): Promise<void> {
  if (!userId || !merchantId) return;
  const cacheKey = `@als_wallet_balance_${merchantId}_${userId}`;
  try {
    const b = await walletApi.getBalance(merchantId);
    await writeCache<number>(cacheKey, b.balance_sar);
  } catch {
    // best effort
  }
}

/* ─── Saved cards ────────────────────────────────────────────────── */

async function warmupSavedCards(userId: string, merchantId: string): Promise<void> {
  if (!userId || !merchantId) return;
  const cacheKey = `@als_saved_cards_${merchantId}_${userId}`;
  try {
    const cards = await paymentApi.getSavedCards(merchantId);
    await writeCache<SavedCard[]>(cacheKey, cards);
  } catch {
    // best effort
  }
}

/* ─── Apple Wallet pass ──────────────────────────────────────────── */

/**
 * Generates the .pkpass on the server and caches the base64 blob so
 * the customer's first tap of "Add to Apple Wallet" is near-instant
 * (just the PassKit hand-off, no server round-trip). The server-side
 * generation is the slow step (~10 s on Khrtoom's first build) and
 * doing it during warmup means the customer never feels it.
 *
 * Skipped on Android, when the pass-generation endpoint isn't
 * available, or when the customer has already added the pass once
 * (offers screen hides the Add button in that state, so prefetching
 * would be wasted bytes).
 */
async function warmupApplePass(
  userId: string,
  merchantId: string,
  alreadyAdded: boolean,
): Promise<void> {
  if (Platform.OS !== 'ios') return;
  if (!userId || !merchantId) return;
  if (alreadyAdded) return;

  const passCacheKey = `@als_apple_pass_${merchantId}_${userId}`;
  // Don't refetch if we already have a cached copy — pass content
  // changes only when the merchant updates their loyalty card design,
  // which is rare. The customer can clear it via reinstall if needed.
  const existing = await readCache<string>(passCacheKey);
  if (existing) return;

  // Cheap check: does the server have a wallet-pass cert configured
  // at all? If not, generating would 404 — skip silently.
  try {
    const ok = await fetchWithTimeout(`${API_URL}/api/loyalty/wallet-pass/check`)
      .then((r) => r.ok)
      .catch(() => false);
    if (!ok) return;
  } catch {
    return;
  }

  try {
    const authToken = await getAuthToken();
    if (!authToken) return;
    const passUrl = `${API_URL}/api/loyalty/wallet-pass?customerId=${encodeURIComponent(
      userId,
    )}&merchantId=${encodeURIComponent(merchantId)}&format=base64`;
    // Pass generation is the slowest payload in the warmup, so it
    // gets a longer timeout than the other fetches (12 s) — server-
    // side cert signing + zip can take a beat on cold lambdas.
    const res = await fetchWithTimeout(
      passUrl,
      { headers: { Authorization: `Bearer ${authToken}` } },
      12000,
    );
    if (!res.ok) return;
    const data = (await res.json().catch(() => null)) as { base64?: string } | null;
    const base64 = data?.base64;
    if (typeof base64 !== 'string' || base64.length === 0) return;
    await writeCache<string>(passCacheKey, base64);
  } catch {
    // best effort
  }
}

/* ─── Wallet availability checks (Apple/Google) ──────────────────── */

/**
 * The offers loyalty tab fires two unrelated probes ('does this server
 * have an Apple wallet-pass cert configured?' and 'does it have a
 * Google wallet issuer?') and gates the visibility of the Add-to-Wallet
 * button on them. Those probes rarely change and add 200-1000 ms to
 * the loyalty page paint. Prefetching them into a cache key the offers
 * screen reads removes that gate from the critical path.
 */
async function warmupWalletAvailability(): Promise<void> {
  try {
    const [apple, google] = await Promise.all([
      fetchWithTimeout(`${API_URL}/api/loyalty/wallet-pass/check`)
        .then((r) => r.ok)
        .catch(() => false),
      fetchWithTimeout(`${API_URL}/api/loyalty/google-wallet/check`)
        .then((r) => (r.ok ? r.json().then((d: any) => Boolean(d?.available)) : false))
        .catch(() => false),
    ]);
    await writeCache<{ apple: boolean; google: boolean }>(
      '@als_wallet_availability',
      { apple, google },
    );
  } catch {
    // best effort
  }
}

/* ─── Public entrypoint ──────────────────────────────────────────── */

export async function runWarmup(ctx: WarmupContext): Promise<void> {
  const { userId, merchantId, applePassAlreadyAdded } = ctx;
  if (!merchantId) return;

  // Phase 1: merchant-scoped data — runs even without auth so the
  // offers tab is hot for guests too. Wallet availability is part of
  // this phase since it's not customer-scoped — the same cache key
  // is shared across users.
  void warmupOffers(merchantId);
  void warmupWalletAvailability();

  if (!userId) return;

  // Phase 2: customer-scoped data — fire all in parallel including
  // the heavy Apple Wallet pass. HTTP/2 multiplexes over a single
  // socket so firing them concurrently doesn't meaningfully slow any
  // individual request, and the previously-applied 1500 ms delay on
  // the pass fetch only ever helped when bandwidth was the bottleneck
  // (which it usually isn't — the server-side cert signing + image
  // composition is). Firing the pass request alongside Phase 2 means
  // the cached pkpass is on disk ~1.5 s sooner, which directly
  // shortens the worst-case window where a customer might tap "Add
  // to Apple Wallet" before warmup finished.
  void warmupLoyalty(userId, merchantId);
  void warmupWallet(userId, merchantId);
  void warmupSavedCards(userId, merchantId);
  void warmupApplePass(userId, merchantId, applePassAlreadyAdded);
}
