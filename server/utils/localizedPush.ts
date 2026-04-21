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
  acceptedDelivery: {
    en: { title: 'Your order is in the kitchen', body: "Cooking now — we'll get a driver on the way as soon as it's ready." },
    ar: { title: 'طلبك في المطبخ', body: 'يتم تحضيره الآن — بنرسلك سائق بمجرد ما يكون جاهز.' },
  },
  acceptedPickup: {
    en: { title: 'Your order is in the kitchen', body: "Cooking now — we'll ping you the moment it's ready to pick up." },
    ar: { title: 'طلبك في المطبخ', body: 'يتم تحضيره الآن — بنخبرك بمجرد ما يكون جاهز للاستلام.' },
  },
  outForDelivery: {
    en: { title: 'Your driver is rolling out', body: 'Food is with them and heading your way.' },
    ar: { title: 'السائق انطلق إليك', body: 'طلبك معه وجاي في طريقه.' },
  },
  driverCloseBy: {
    en: { title: 'Almost at your door', body: 'Your driver is less than a minute away.' },
    ar: { title: 'اقترب السائق من عندك', body: 'باقي أقل من دقيقة ويصلك.' },
  },
  delivered: {
    en: { title: 'Delivered — enjoy!', body: "Your order just landed. Dig in while it's hot." },
    ar: { title: 'وصل طلبك — بالهنا والشفا!', body: 'طلبك وصل توك. استمتع فيه وهو ساخن.' },
  },
  received: {
    en: { title: 'Thanks for picking up!', body: "Hope it's every bit as good as it smells." },
    ar: { title: 'شكراً لاستلامك', body: 'إن شاء الله يكون بقدر ريحته الحلوة.' },
  },
  cancelledByStore: {
    en: {
      title: "Couldn't make it work this time",
      body: 'The store had to cancel your order. No charge on your card — promise.',
    },
    ar: {
      title: 'ما قدرنا ننفذ الطلب',
      body: 'اضطر المتجر لإلغاء طلبك. ما خصمنا شي من بطاقتك، وعد.',
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
