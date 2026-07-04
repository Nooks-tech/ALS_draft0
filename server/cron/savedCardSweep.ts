/**
 * Saved-card sweep cron — runs every 6 hours.
 *
 * Walks customer_saved_cards rows and asks Moyasar for each token's
 * current state. Any token Moyasar reports as `inactive` (card
 * expired or 3DS verification failed) or that returns 404 (token
 * deleted on Moyasar's side, e.g. test-environment housekeeping
 * 2026-05-15) is removed from our DB so the customer never sees a
 * dead card in the picker. The same defensive cleanup runs lazily
 * inside /token-pay and /topup-with-saved-card when a charge
 * actually fails, but doing it proactively saves the customer from
 * the "payment failed" surprise at checkout time.
 *
 * Rate-limited: at most 1 token check per 100ms (10/sec) so we
 * don't hammer Moyasar's /v1/tokens endpoint if a merchant has
 * thousands of saved cards.
 */
import { createClient } from '@supabase/supabase-js';
import { getMerchantPaymentRuntimeConfig } from '../lib/merchantIntegrations';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
const BATCH_LIMIT = 500;
const PER_TOKEN_DELAY_MS = 100;
// Stop paginating if a sweep somehow runs this long — the next tick's
// sweep starts over from the top and re-covers whatever was left.
const SWEEP_BUDGET_MS = 2 * 60 * 60 * 1000;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One config fetch per merchant per sweep instead of per card — a
// merchant with 500 saved cards was previously 500 identical lookups.
type MerchantKeyCache = Map<string, string | null>;

async function checkOne(
  card: { id: string; customer_id: string; merchant_id: string; token: string },
  keyCache: MerchantKeyCache,
) {
  if (!supabaseAdmin) return;
  let secretKey: string | null | undefined = keyCache.get(card.merchant_id);
  if (secretKey === undefined) {
    try {
      const runtimeConfig = await getMerchantPaymentRuntimeConfig(card.merchant_id);
      secretKey = runtimeConfig.secretKey ?? null;
    } catch (err: any) {
      console.warn('[SavedCardSweep] Could not load merchant config:', card.merchant_id, err?.message);
      secretKey = null;
    }
    keyCache.set(card.merchant_id, secretKey);
  }
  if (!secretKey) return;

  try {
    const res = await fetch(`https://api.moyasar.com/v1/tokens/${encodeURIComponent(card.token)}`, {
      headers: { Authorization: `Basic ${Buffer.from(secretKey + ':').toString('base64')}` },
    });
    if (res.status === 404) {
      await supabaseAdmin
        .from('customer_saved_cards')
        .delete()
        .eq('id', card.id);
      console.log('[SavedCardSweep] Removed missing-token card', card.id);
      return;
    }
    if (!res.ok) {
      // 5xx, network blips, etc. — leave the row alone, retry next tick.
      return;
    }
    const body: any = await res.json().catch(() => null);
    const status = String(body?.status ?? '').toLowerCase();
    if (status === 'inactive' || status === 'failed' || status === 'expired') {
      await supabaseAdmin
        .from('customer_saved_cards')
        .delete()
        .eq('id', card.id);
      console.log('[SavedCardSweep] Removed', status, 'card', card.id);
    }
  } catch (err: any) {
    // Network error talking to Moyasar — just skip this tick.
    console.warn('[SavedCardSweep] Probe failed for card', card.id, err?.message);
  }
}

let sweepInFlight = false;

async function runSweep() {
  if (!supabaseAdmin) return;
  if (sweepInFlight) {
    console.warn('[SavedCardSweep] previous sweep still running — skipping this interval');
    return;
  }
  sweepInFlight = true;
  try {
    const startedAt = Date.now();
    const keyCache: MerchantKeyCache = new Map();
    // Keyset pagination ordered by id: the old single unordered
    // .limit(500) fetched the same ~500 physical-order rows every tick,
    // so cards 501+ were NEVER swept and dead tokens surfaced as
    // "payment failed" at checkout.
    let lastId = '';
    let checked = 0;
    for (;;) {
      let query = supabaseAdmin
        .from('customer_saved_cards')
        .select('id, customer_id, merchant_id, token')
        .order('id', { ascending: true })
        .limit(BATCH_LIMIT);
      if (lastId) query = query.gt('id', lastId);
      const { data, error } = await query;
      if (error) {
        console.warn('[SavedCardSweep] List query failed:', error.message);
        return;
      }
      if (!data?.length) break;
      console.log(`[SavedCardSweep] Checking batch of ${data.length} saved cards (total so far: ${checked})`);
      for (const card of data as Array<{ id: string; customer_id: string; merchant_id: string; token: string }>) {
        await checkOne(card, keyCache);
        checked += 1;
        await sleep(PER_TOKEN_DELAY_MS);
      }
      lastId = String((data[data.length - 1] as { id: string }).id);
      if (data.length < BATCH_LIMIT) break; // drained
      if (Date.now() - startedAt > SWEEP_BUDGET_MS) {
        console.warn(`[SavedCardSweep] budget exhausted after ${checked} cards — resuming next tick`);
        break;
      }
    }
    if (checked > 0) console.log(`[SavedCardSweep] Sweep complete — ${checked} cards checked`);
  } finally {
    sweepInFlight = false;
  }
}

async function heartbeatTick() {
  const { runWithHeartbeat } = await import('../utils/cronHeartbeat');
  await runWithHeartbeat('savedCardSweep', runSweep);
}

export function startSavedCardSweepCron() {
  console.log('[Cron] Saved-card sweep started (every 6h)');
  setInterval(() => {
    heartbeatTick().catch((err) =>
      console.error('[SavedCardSweep] heartbeatTick rejected (captured):', err?.message),
    );
  }, POLL_INTERVAL_MS);
  // First run 5 min after startup so we don't slow boot.
  setTimeout(() => {
    heartbeatTick().catch((err) =>
      console.error('[SavedCardSweep] startup heartbeatTick rejected:', err?.message),
    );
  }, 5 * 60 * 1000);
}
