import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Shared, merchant-scoped push helpers.
 *
 * Background — every Nooks merchant ships its own white-label app, and
 * a single Supabase auth.uid (= one phone number) ends up registered as
 * a customer across multiple merchants' apps. When we send a push by
 * user_id alone, the same notification fans out to every brand the
 * customer has installed — wrong logo, confused user. This helper
 * REQUIRES `merchantId` so the push_subscriptions query is always
 * filtered by both (user_id, merchant_id).
 *
 * Use these helpers in place of any local `sendPush` / `sendPushToCustomer`
 * function that queries push_subscriptions directly. The five audit-found
 * leaks (cron/loyaltyExpiration, cron/complaintEscalation, routes/complaints,
 * utils/localizedPush, routes/loyalty milestone unlock) all moved to call
 * one of the two functions below.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;

let cachedClient: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (cachedClient) return cachedClient;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  cachedClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  return cachedClient;
}

export type PushChannel = 'orders' | 'loyalty' | 'marketing' | 'operations';

export type LocalizedCopy = { title: string; body: string };
export type Copy = { en: LocalizedCopy; ar: LocalizedCopy };

/**
 * Send a single-language push to one customer at one merchant.
 * Scopes push_subscriptions by (user_id, merchant_id) — never falls
 * through to fan-out across merchants.
 */
export async function sendPushScoped(opts: {
  customerId: string;
  merchantId: string;
  title: string;
  body: string;
  channel?: PushChannel;
}): Promise<void> {
  const { customerId, merchantId, title, body, channel = 'orders' } = opts;
  if (!customerId || !merchantId) return;
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { data: subs } = await sb
      .from('push_subscriptions')
      .select('expo_push_token')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId);
    const tokens = (subs ?? [])
      .map((s: { expo_push_token?: string | null }) => (s.expo_push_token || '').trim())
      .filter(Boolean);
    if (tokens.length === 0) return;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${EXPO_ACCESS_TOKEN}`;
    const messages = tokens.map((t) => ({
      to: t,
      sound: 'default',
      title,
      body,
      channelId: channel,
    }));
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers,
      body: JSON.stringify(messages),
    });
  } catch (e: unknown) {
    console.warn('[push] sendPushScoped failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * Localized variant — picks language with this preference order:
 *   1. customer_merchant_profiles.language (Phase F source of truth —
 *      per-(merchant, customer), set when the customer changes their
 *      app language in the profile screen)
 *   2. push_subscriptions.app_language (per-device fallback, used
 *      when the customer hasn't set a profile-level language yet)
 *   3. English default
 * Same merchant scoping applies — language never crosses merchant
 * boundaries even on a phone the same human uses for two apps.
 */
export async function sendLocalizedPushScoped(opts: {
  customerId: string;
  merchantId: string;
  copy: Copy;
  channel?: PushChannel;
}): Promise<void> {
  const { customerId, merchantId, copy, channel = 'orders' } = opts;
  if (!customerId || !merchantId) return;
  const sb = getSupabase();
  if (!sb) return;
  try {
    const [profileQuery, subsQuery] = await Promise.all([
      sb
        .from('customer_merchant_profiles')
        .select('language')
        .eq('merchant_id', merchantId)
        .eq('customer_id', customerId)
        .maybeSingle(),
      sb
        .from('push_subscriptions')
        .select('expo_push_token, app_language')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId),
    ]);

    const profileLang = (profileQuery.data as { language?: string | null } | null)?.language ?? null;
    const subs = (subsQuery.data ?? []) as Array<{
      expo_push_token: string;
      app_language: 'en' | 'ar' | null;
    }>;

    const messages = subs
      .map((s) => {
        const token = (s.expo_push_token || '').trim();
        if (!token) return null;
        const lang =
          profileLang === 'ar' || (profileLang !== 'en' && s.app_language === 'ar')
            ? 'ar'
            : 'en';
        const c = copy[lang];
        return {
          to: token,
          sound: 'default',
          title: c.title,
          body: c.body,
          channelId: channel,
        };
      })
      .filter((m): m is NonNullable<typeof m> => !!m);
    if (messages.length === 0) {
      // 2026-05-22 observability: empty messages means we found
      // subscription rows but none had a usable token. Worth knowing.
      console.warn('[push] sendLocalizedPushScoped: no usable tokens', {
        customerId,
        merchantId,
        channel,
        subscriptionCount: subs.length,
      });
      return;
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${EXPO_ACCESS_TOKEN}`;
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers,
      body: JSON.stringify(messages),
    });
    // 2026-05-22: read per-token receipts so dead tokens surface
    // instead of vanishing into a silent 200. Mirrors the same logic
    // in sendPushToCustomer (routes/orders.ts).
    let okCount = 0;
    let errorCount = 0;
    const tokenErrors: Array<{ status: string; code?: string; message?: string }> = [];
    if (res.ok) {
      try {
        const json = (await res.json()) as {
          data?: Array<{ status?: string; message?: string; details?: { error?: string } }>;
        };
        const receipts = Array.isArray(json?.data) ? json.data : [];
        receipts.forEach((rcpt) => {
          if (rcpt?.status === 'ok') okCount += 1;
          else {
            errorCount += 1;
            tokenErrors.push({
              status: rcpt?.status ?? 'unknown',
              code: rcpt?.details?.error,
              message: rcpt?.message,
            });
          }
        });
      } catch {
        // Parse failed; treat as ok-on-HTTP-2xx.
      }
    } else {
      errorCount = messages.length;
      const errBody = await res.text().catch(() => '');
      console.warn('[push] sendLocalizedPushScoped Expo HTTP non-2xx', {
        customerId,
        merchantId,
        channel,
        status: res.status,
        body: errBody.slice(0, 200),
      });
    }
    if (errorCount === 0 && okCount > 0) {
      console.log('[push] Sent', { customerId, merchantId, channel, tokenCount: okCount });
    } else if (errorCount > 0) {
      console.warn('[push] Partial / total failure', {
        customerId,
        merchantId,
        channel,
        ok: okCount,
        errors: errorCount,
        tokenErrors,
      });
    }
  } catch (e: unknown) {
    console.warn('[push] sendLocalizedPushScoped failed:', e instanceof Error ? e.message : e);
  }
}
