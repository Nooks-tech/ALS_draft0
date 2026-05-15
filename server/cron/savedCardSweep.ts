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

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkOne(card: { id: string; customer_id: string; merchant_id: string; token: string }) {
  if (!supabaseAdmin) return;
  let secretKey: string | null | undefined;
  try {
    const runtimeConfig = await getMerchantPaymentRuntimeConfig(card.merchant_id);
    secretKey = runtimeConfig.secretKey;
  } catch (err: any) {
    console.warn('[SavedCardSweep] Could not load merchant config:', card.merchant_id, err?.message);
    return;
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

async function runSweep() {
  if (!supabaseAdmin) return;
  const { data, error } = await supabaseAdmin
    .from('customer_saved_cards')
    .select('id, customer_id, merchant_id, token')
    .limit(BATCH_LIMIT);
  if (error) {
    console.warn('[SavedCardSweep] List query failed:', error.message);
    return;
  }
  if (!data?.length) return;
  console.log(`[SavedCardSweep] Checking ${data.length} saved cards`);
  for (const card of data as Array<{ id: string; customer_id: string; merchant_id: string; token: string }>) {
    await checkOne(card);
    await sleep(PER_TOKEN_DELAY_MS);
  }
}

export function startSavedCardSweepCron() {
  console.log('[Cron] Saved-card sweep started (every 6h)');
  setInterval(() => {
    runSweep().catch((err) =>
      console.error('[SavedCardSweep] runSweep rejected (should be impossible):', err),
    );
  }, POLL_INTERVAL_MS);
  // First run 5 min after startup so we don't slow boot.
  setTimeout(() => {
    runSweep().catch((err) =>
      console.error('[SavedCardSweep] startup runSweep rejected:', err),
    );
  }, 5 * 60 * 1000);
}
