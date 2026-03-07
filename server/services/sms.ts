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
}

/**
 * Send an SMS via MadarSMS.
 * @param to  Phone number in international format without '+' (e.g. 966512345678)
 * @param message  Message body (max ~160 chars for single segment)
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
      console.error('[SMS] MadarSMS error:', data);
      return { ok: false, error: data?.ErrorDescription || `HTTP ${res.status}` };
    }

    console.log('[SMS] Sent to', to, '→', data);
    return { ok: true, messageId: data?.MessageID || data?.messageId };
  } catch (err) {
    console.error('[SMS] Fetch error:', err);
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
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
