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
  /** Accepted for caller compatibility but no longer used — the pass
   *  prefetch was removed 2026-07-17 (both add paths fetch fresh at tap
   *  time; see the tombstone comment below). */
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

/* ─── Apple Wallet pass ─── (prefetch removed 2026-07-17)
   The pass used to be pre-generated and cached here so the Add button felt
   instant — but the pass renders the customer's LIVE balance, and both add
   paths now deliberately fetch it fresh at tap time (a cached pass doesn't
   just preview stale, PassKit INSTALLS the stale snapshot over the fresher
   pass already in the wallet). With no readers left, prefetching was pure
   waste: the single most expensive warmup call (server-side cert signing +
   zip) on every app launch, written into a cache nothing consumes. */

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
  const { userId, merchantId } = ctx;
  if (!merchantId) return;

  // Phase 1: merchant-scoped data — runs even without auth so the
  // offers tab is hot for guests too. Wallet availability is part of
  // this phase since it's not customer-scoped — the same cache key
  // is shared across users.
  void warmupOffers(merchantId);
  void warmupWalletAvailability();

  if (!userId) return;

  // Phase 2: customer-scoped data — fire all in parallel. HTTP/2
  // multiplexes over a single socket, so firing them concurrently
  // doesn't meaningfully slow any individual request.
  void warmupLoyalty(userId, merchantId);
  void warmupWallet(userId, merchantId);
  void warmupSavedCards(userId, merchantId);
}
