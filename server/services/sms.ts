/**
 * MadarSMS (Orbit Technology) – send SMS via api.mobile.net.sa
 */

const MADAR_API_BASE = 'https://api.mobile.net.sa/api/v1';
const MADAR_API_KEY = process.env.MADAR_SMS_API_KEY || '';
const MADAR_SENDER = process.env.MADAR_SMS_SENDER || 'Nooks';

export interface SendSmsResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** HTTP status from Madar, when available. Useful for distinguishing 401/403 (bad key / revoked sender) from 5xx. */
  status?: number;
  /** Raw error code Madar returned (ErrorCode field). Stable across locales. */
  errorCode?: string | number;
}

// In-memory consecutive-failure tracker. Resets on process restart, which is
// fine — we just want a breadcrumb that prints a LOUD log line when Madar
// starts systematically rejecting our sends. Saves having to tail Railway
// when the sender name gets revoked again.
let consecutiveFailures = 0;
const FAILURE_ALERT_THRESHOLD = 5;

/**
 * Send an SMS via MadarSMS.
 * @param to  Phone number in international format without '+' (e.g. 966512345678)
 * @param message  Message body (Arabic = 70 chars/segment, Latin = 160)
 */
export async function sendSms(to: string, message: string): Promise<SendSmsResult> {
  if (!MADAR_API_KEY) {
    console.warn('[SMS] MADAR_SMS_API_KEY not set – OTP will only appear in server logs');
    return { ok: false, error: 'SMS service not configured' };
  }

  try {
    const res = await fetch(`${MADAR_API_BASE}/SendSMS`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: MADAR_API_KEY,
        numbers: to,
        sender: MADAR_SENDER,
        message,
      }),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || (data && data.ErrorCode)) {
      consecutiveFailures += 1;
      const errorDescription: string = data?.ErrorDescription || `HTTP ${res.status}`;
      const errorCode: string | number | undefined = data?.ErrorCode;
      console.error(
        '[SMS] MadarSMS error:',
        JSON.stringify({
          status: res.status,
          sender: MADAR_SENDER,
          errorCode,
          errorDescription,
        }),
      );
      if (consecutiveFailures === FAILURE_ALERT_THRESHOLD) {
        console.error(
          `[SMS] ALERT — ${FAILURE_ALERT_THRESHOLD} consecutive Madar failures. ` +
            `Sender "${MADAR_SENDER}" is likely revoked or API key rotated. ` +
            `Check Madar portal, rotate MADAR_SMS_SENDER or set ALLOW_OTP_FALLBACK=true to keep users unblocked.`,
        );
      }
      return {
        ok: false,
        error: errorDescription,
        status: res.status,
        errorCode,
      };
    }

    // Reset the counter on any successful send — we only care about a
    // streak, not a lifetime total.
    if (consecutiveFailures > 0) {
      console.log(`[SMS] Recovered after ${consecutiveFailures} consecutive failures`);
      consecutiveFailures = 0;
    }
    console.log('[SMS] Sent to', to, '→', data);
    return { ok: true, messageId: data?.MessageID || data?.messageId };
  } catch (err) {
    consecutiveFailures += 1;
    console.error('[SMS] Fetch error:', err);
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

/**
 * Build a bilingual OTP message (Arabic + English) short enough to fit in a
 * single Unicode SMS segment (70-char limit). Keeping it brand-agnostic on
 * purpose — the "sender" field on the SMS carries the brand name, the body
 * just needs to identify the intent and the code.
 */
export function otpMessage(code: string): string {
  return `رمز التحقق: ${code}\nYour verification code: ${code}`;
}

/**
 * Normalise any Saudi phone input to 966XXXXXXXXX (no '+' prefix).
 * Accepts: +966..., 966..., 05..., 5...
 */
export function normalizePhone(raw: string): string {
  let d = raw.replace(/[^0-9]/g, '');
  if (d.startsWith('966')) return d;
  if (d.startsWith('05')) return '966' + d.slice(1);
  if (d.startsWith('5') && d.length === 9) return '966' + d;
  if (d.startsWith('00966')) return d.slice(2);
  return d;
}
