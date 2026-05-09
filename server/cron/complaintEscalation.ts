/**
 * Complaint escalation cron – runs every 30 minutes:
 * Auto-escalates pending complaints older than 24 hours to HQ
 */
import { createClient } from '@supabase/supabase-js';
import { sendPushScoped } from '../utils/push';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const ESCALATION_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const POLL_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes

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
    // Atomic claim — only proceed for this complaint if WE are the
    // first writer to flip escalated_at. Without this WHERE filter,
    // two server replicas running the cron concurrently would both
    // claim the same rows and double-escalate. .select() returns the
    // rows we actually updated; an empty array means another replica
    // beat us to it and we skip the rest of this iteration.
    const { data: claimed } = await supabaseAdmin
      .from('order_complaints')
      .update({
        escalated_at: new Date().toISOString(),
        escalated_to: 'hq',
        escalation_reason: 'Unresolved for 24+ hours',
      })
      .eq('id', complaint.id)
      .is('escalated_at', null)
      .select('id');
    if (!claimed || claimed.length === 0) {
      console.log(`[Complaint Cron] Skipping ${complaint.id} — already escalated by another worker`);
      continue;
    }

    // Find merchant owner to notify
    const { data: merchant } = await supabaseAdmin
      .from('merchants')
      .select('id')
      .eq('id', complaint.merchant_id)
      .single();

    if (merchant) {
      // Notify the merchant owner (NOT the customer). Look up the
      // owner's user_id so the push lands on whichever device that
      // user has the merchant dashboard installed on. Even though the
      // recipient is the merchant owner, scope by the same merchant_id
      // so we don't spray cross-merchant if the owner happens to also
      // be a customer of another merchant under the same auth.uid.
      const { data: ownerRow } = await supabaseAdmin
        .from('merchants')
        .select('user_id')
        .eq('id', complaint.merchant_id)
        .maybeSingle();
      const ownerUserId = (ownerRow as { user_id?: string | null } | null)?.user_id;
      if (ownerUserId) {
        sendPushScoped({
          customerId: ownerUserId,
          merchantId: String(complaint.merchant_id),
          title: 'Complaint Escalated',
          body: `Complaint for order ${complaint.order_id} has been escalated — unresolved for 24+ hours.`,
          channel: 'operations',
        });
      }
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
