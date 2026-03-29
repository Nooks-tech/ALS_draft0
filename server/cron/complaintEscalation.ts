/**
 * Complaint escalation cron – runs every 30 minutes:
 * Auto-escalates pending complaints older than 24 hours to HQ
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const ESCALATION_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const POLL_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes

async function sendPush(userId: string, title: string, body: string) {
  if (!supabaseAdmin) return;
  try {
    const { data: subs } = await supabaseAdmin
      .from('push_subscriptions')
      .select('expo_push_token')
      .eq('user_id', userId);
    const tokens = (subs ?? []).map((s: any) => s.expo_push_token).filter(Boolean);
    if (tokens.length === 0) return;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${EXPO_ACCESS_TOKEN}`;
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers,
      body: JSON.stringify(tokens.map((t: string) => ({
        to: t, sound: 'default', title, body, channelId: 'operations',
      }))),
    });
  } catch { /* best-effort */ }
}

async function escalateStaleComplaints() {
  if (!supabaseAdmin) return;

  const cutoff = new Date(Date.now() - ESCALATION_THRESHOLD_MS).toISOString();

  const { data: staleComplaints, error } = await supabaseAdmin
    .from('order_complaints')
    .select('id, merchant_id, customer_id, order_id, complaint_type')
    .eq('status', 'pending')
    .is('escalated_at', null)
    .lt('created_at', cutoff)
    .limit(50);

  if (error || !staleComplaints?.length) {
    if (error) console.warn('[Complaint Cron] Escalation query failed:', error.message);
    return;
  }

  console.log(`[Complaint Cron] Escalating ${staleComplaints.length} stale complaints`);

  for (const complaint of staleComplaints) {
    await supabaseAdmin
      .from('order_complaints')
      .update({
        escalated_at: new Date().toISOString(),
        escalated_to: 'hq',
        escalation_reason: 'Unresolved for 24+ hours',
      })
      .eq('id', complaint.id);

    // Find merchant owner to notify
    const { data: merchant } = await supabaseAdmin
      .from('merchants')
      .select('id')
      .eq('id', complaint.merchant_id)
      .single();

    if (merchant) {
      // Notify via merchant_id as the user lookup — the owner's auth.uid matches merchants.id
      // in nooksweb's auth flow (merchant is linked to auth user)
      sendPush(
        String(complaint.merchant_id),
        'Complaint Escalated',
        `Complaint for order ${complaint.order_id} has been escalated — unresolved for 24+ hours.`,
      );
    }

    console.log(`[Complaint Cron] Escalated complaint ${complaint.id} for order ${complaint.order_id}`);
  }
}

export function startComplaintEscalationCron() {
  console.log('[Cron] Complaint escalation cron started (every 30 min)');
  setInterval(escalateStaleComplaints, POLL_INTERVAL_MS);
  // First run 60s after startup
  setTimeout(escalateStaleComplaints, 60_000);
}
