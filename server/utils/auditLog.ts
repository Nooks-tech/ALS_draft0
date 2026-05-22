import { createClient } from '@supabase/supabase-js';
import { captureError } from './sentryContext';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

/**
 * Shared writeAudit helper — every route that needs to record an
 * event in audit_log should use this instead of inlining the insert.
 *
 * Phase B observability:
 *   - Audit failures used to swallow into `console.warn` and vanish.
 *     If the audit trail itself is broken, the user thinks every
 *     state change was recorded when it actually wasn't. We now
 *     ALSO ship the failure to Sentry so the trail-breakage is
 *     visible in the same dashboard the user already watches.
 *   - merchant_id is optional (some audit events are platform-level
 *     and not tied to a merchant); pass null in that case.
 *   - payload is freeform JSON; keep it small and scrubbed of secrets.
 */
export async function writeAudit(row: {
  merchant_id?: string | null;
  action: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    const { error } = await supabaseAdmin.from('audit_log').insert({
      merchant_id: row.merchant_id ?? null,
      action: row.action,
      payload: row.payload ?? {},
    });
    if (error) {
      console.warn('[audit] write failed:', { action: row.action, merchant_id: row.merchant_id, error: error.message });
      captureError(new Error(`audit_log insert failed: ${error.message}`), {
        component: 'auditLog.write',
        merchantId: row.merchant_id ?? undefined,
        extra: { action: row.action, db_error: error.message },
      });
    }
  } catch (err: any) {
    // Promise rejection (network / driver issue). Same treatment.
    console.warn('[audit] write threw:', { action: row.action, merchant_id: row.merchant_id, error: err?.message });
    captureError(err, {
      component: 'auditLog.write',
      merchantId: row.merchant_id ?? undefined,
      extra: { action: row.action, threw: true },
    });
  }
}
