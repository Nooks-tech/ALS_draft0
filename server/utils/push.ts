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
      .eq('user_id', customerId)
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
 * Localized variant — picks per-device language from
 * push_subscriptions.app_language. Falls back to English when null.
 * Same merchant scoping applies.
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
    const { data } = await sb
      .from('push_subscriptions')
      .select('expo_push_token, app_language')
      .eq('user_id', customerId)
      .eq('merchant_id', merchantId);
    const subs = (data ?? []) as Array<{
      expo_push_token: string;
      app_language: 'en' | 'ar' | null;
    }>;
    const messages = subs
      .map((s) => {
        const token = (s.expo_push_token || '').trim();
        if (!token) return null;
        const lang = s.app_language === 'ar' ? 'ar' : 'en';
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
    if (messages.length === 0) return;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${EXPO_ACCESS_TOKEN}`;
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers,
      body: JSON.stringify(messages),
    });
  } catch (e: unknown) {
    console.warn('[push] sendLocalizedPushScoped failed:', e instanceof Error ? e.message : e);
  }
}
