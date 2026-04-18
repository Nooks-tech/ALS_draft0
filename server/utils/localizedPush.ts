/**
 * Localized push helper (mirror of nooksweb/lib/customer-push.ts).
 *
 * The OTO webhook lives in this Express server, so we keep a parallel copy
 * of the push copy + sender. Both files MUST stay in sync — update copy in
 * both places or move the copy to a shared supabase table later.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

export type LocalizedCopy = { title: string; body: string };
export type Copy = { en: LocalizedCopy; ar: LocalizedCopy };

export const ORDER_PUSH_COPY = {
  accepted: {
    en: { title: 'Order accepted', body: 'Great news — the store accepted your order and is starting to prepare it.' },
    ar: { title: 'تم قبول طلبك', body: 'المتجر قبل طلبك وبدأ في تحضيره.' },
  },
  preparing: {
    en: { title: 'Preparing your order', body: 'The kitchen is working on your order now.' },
    ar: { title: 'جاري تحضير طلبك', body: 'المطبخ يحضر طلبك الآن.' },
  },
  readyPickup: {
    en: { title: 'Order ready!', body: 'Your order is ready for pickup at the store.' },
    ar: { title: 'طلبك جاهز!', body: 'يمكنك استلام طلبك من المتجر الآن.' },
  },
  outForDelivery: {
    en: { title: 'On the way', body: 'Your order has left the store and is on its way.' },
    ar: { title: 'في الطريق', body: 'طلبك خرج من المتجر وهو في الطريق إليك.' },
  },
  driverCloseBy: {
    en: { title: 'Driver is close by', body: 'Your driver is less than 1 km away.' },
    ar: { title: 'السائق قريب منك', body: 'السائق على بعد أقل من كيلومتر.' },
  },
  delivered: {
    en: { title: 'Order delivered', body: 'Your order has been delivered. Enjoy!' },
    ar: { title: 'تم توصيل الطلب', body: 'تم توصيل طلبك. نتمنى لك وجبة شهية!' },
  },
  cancelledByStore: {
    en: {
      title: 'Order cancelled',
      body: "The store couldn't fulfil your order. Your payment has been reversed in full.",
    },
    ar: {
      title: 'تم إلغاء الطلب',
      body: 'لم يتمكن المتجر من تنفيذ طلبك. تم إرجاع المبلغ بالكامل.',
    },
  },
} as const;

export async function sendLocalizedPushToCustomer(
  customerId: string,
  copy: Copy,
): Promise<void> {
  if (!customerId || !supabaseAdmin) return;
  try {
    const { data } = await supabaseAdmin
      .from('push_subscriptions')
      .select('expo_push_token, app_language')
      .eq('user_id', customerId);
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
          channelId: 'marketing',
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
  } catch (e: any) {
    console.warn('[localizedPush] failed:', e?.message);
  }
}
