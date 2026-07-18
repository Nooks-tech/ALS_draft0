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
import { decryptSavedCardToken } from '../routes/payment';
import { writeAudit } from '../utils/auditLog';
import { sendLocalizedPushScoped } from '../utils/push';
import {
  CURSOR_NAME,
  EMPTY_CURSOR,
  driveSweep,
  parseCursor,
  type SweepCursor,
} from './savedCardSweepCursor';

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

// Best-effort customer notice for a card the sweep just removed. Mirrors
// cartAbandonment.ts's sendLocalizedPushScoped usage — the helper itself
// never throws, but we wrap it too so a push failure can never surface
// past this point and disturb the sweep.
async function notifyCardRemoved(card: {
  id: string;
  customer_id: string;
  merchant_id: string;
  last_four: string | null;
}) {
  try {
    const lastFour = card.last_four ?? '';
    await sendLocalizedPushScoped({
      customerId: card.customer_id,
      merchantId: card.merchant_id,
      channel: 'orders',
      copy: {
        en: {
          title: 'Saved card removed',
          body: `Your saved card •••• ${lastFour} is no longer valid and was removed. Please add it again.`,
        },
        ar: {
          title: 'تمت إزالة البطاقة المحفوظة',
          body: `بطاقتك المحفوظة •••• ${lastFour} لم تعد صالحة وتمت إزالتها. يرجى إضافتها مرة أخرى.`,
        },
      },
    });
  } catch (err: any) {
    console.warn('[SavedCardSweep] removal push failed', card.id, err?.message);
  }
}

async function checkOne(
  card: {
    id: string;
    customer_id: string;
    merchant_id: string;
    token: string;
    brand: string | null;
    last_four: string | null;
  },
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

  // PRIV-02: card.token is now an encrypted envelope — decrypt to the raw
  // Moyasar token before probing. If decrypt fails, SKIP the card (never
  // delete on a decrypt failure — that would wipe every encrypted card).
  let moyasarToken: string;
  try {
    moyasarToken = decryptSavedCardToken(card.token);
  } catch (err: any) {
    console.warn('[SavedCardSweep] token decrypt failed, skipping card', card.id, err?.message);
    return;
  }

  try {
    const res = await fetch(`https://api.moyasar.com/v1/tokens/${encodeURIComponent(moyasarToken)}`, {
      headers: { Authorization: `Basic ${Buffer.from(secretKey + ':').toString('base64')}` },
    });
    if (res.status === 404) {
      await supabaseAdmin
        .from('customer_saved_cards')
        .delete()
        .eq('id', card.id);
      console.log('[SavedCardSweep] Removed missing-token card', card.id);
      await writeAudit({
        merchant_id: card.merchant_id,
        action: 'saved_card.sweep_removed',
        payload: {
          card_id: card.id,
          customer_id: card.customer_id,
          brand: card.brand ?? null,
          last_four: card.last_four ?? null,
          reason: 'moyasar_404',
        },
      });
      await notifyCardRemoved(card);
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
      await writeAudit({
        merchant_id: card.merchant_id,
        action: 'saved_card.sweep_removed',
        payload: {
          card_id: card.id,
          customer_id: card.customer_id,
          brand: card.brand ?? null,
          last_four: card.last_four ?? null,
          reason: status,
        },
      });
      await notifyCardRemoved(card);
    }
  } catch (err: any) {
    // Network error talking to Moyasar — just skip this tick.
    console.warn('[SavedCardSweep] Probe failed for card', card.id, err?.message);
  }
}

let sweepInFlight = false;

type SavedCard = {
  id: string;
  customer_id: string;
  merchant_id: string;
  token: string;
  brand: string | null;
  last_four: string | null;
};

// Durable resume cursor (SCAL-013). Persisted in the shared cron_cursors
// table so a run cut short by SWEEP_BUDGET_MS resumes on the next tick
// instead of restarting at the head and aging out the tail.
async function loadCursor(): Promise<SweepCursor> {
  if (!supabaseAdmin) return EMPTY_CURSOR;
  try {
    const { data, error } = await supabaseAdmin
      .from('cron_cursors')
      .select('cursor')
      .eq('name', CURSOR_NAME)
      .maybeSingle();
    if (error) {
      console.warn('[SavedCardSweep] cursor load failed — starting from head:', error.message);
      return EMPTY_CURSOR;
    }
    return parseCursor(data?.cursor);
  } catch (err: any) {
    console.warn('[SavedCardSweep] cursor load threw — starting from head:', err?.message);
    return EMPTY_CURSOR;
  }
}

async function saveCursor(cursor: SweepCursor): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin
      .from('cron_cursors')
      .upsert(
        { name: CURSOR_NAME, cursor, updated_at: new Date().toISOString() },
        { onConflict: 'name' },
      );
    if (error) console.warn('[SavedCardSweep] cursor save failed:', error.message);
  } catch (err: any) {
    console.warn('[SavedCardSweep] cursor save threw:', err?.message);
  }
}

async function runSweep() {
  if (!supabaseAdmin) return;
  if (sweepInFlight) {
    console.warn('[SavedCardSweep] previous sweep still running — skipping this interval');
    return;
  }
  sweepInFlight = true;
  try {
    const keyCache: MerchantKeyCache = new Map();
    // Keyset pagination ordered by id (the old single unordered .limit(500)
    // fetched the same ~500 physical-order rows every tick, so cards 501+
    // were NEVER swept). The cursor is now DURABLE across ticks — see driver.
    await driveSweep<SavedCard>({
      loadCursor,
      saveCursor,
      fetchBatch: async (afterId, limit) => {
        let query = supabaseAdmin!
          .from('customer_saved_cards')
          .select('id, customer_id, merchant_id, token, brand, last_four')
          .order('id', { ascending: true })
          .limit(limit);
        if (afterId) query = query.gt('id', afterId);
        const { data, error } = await query;
        if (error) {
          console.warn('[SavedCardSweep] List query failed:', error.message);
          return null; // driver leaves the cursor in place for the next tick
        }
        return (data ?? []) as SavedCard[];
      },
      processRow: (card) => checkOne(card, keyCache),
      now: Date.now,
      batchLimit: BATCH_LIMIT,
      budgetMs: SWEEP_BUDGET_MS,
      delay: sleep,
      perRowDelayMs: PER_TOKEN_DELAY_MS,
      onLog: (m) => console.log(`[SavedCardSweep] ${m}`),
    });
  } finally {
    sweepInFlight = false;
  }
}

async function heartbeatTick() {
  const { tryClaimCronTick } = await import('../utils/cronLock');
  if (!(await tryClaimCronTick('savedCardSweep', 5.5 * 60 * 60))) {
    console.log('[SavedCardSweep] tick claimed by another replica — skipping');
    return;
  }
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
