/**
 * Auth routes – SMS OTP via MadarSMS + Supabase user management
 *
 * Flow:
 *  1. POST /send-otp { phone } → generate code, store in sms_otp, send via MadarSMS
 *  2. POST /verify-otp { phone, code } → verify code, find-or-create Supabase user,
 *     return session tokens so the client can call supabase.auth.setSession()
 */
import { Router, type Request } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'crypto';
import { sendSms, normalizePhone, otpMessage } from '../services/sms';
import { creditMerchantSmsWallet, debitMerchantSmsWallet } from '../lib/smsWallet';

/**
 * Mask a Saudi number for logs/audit: keep prefix + last 3, redact the middle.
 * Raw phones in audit rows would fail Saudi PDPL if we ever export the log.
 */
function maskPhone(p: string): string {
  if (!p || p.length < 6) return p ?? '';
  return p.slice(0, 3) + '*'.repeat(Math.max(0, p.length - 6)) + p.slice(-3);
}

/**
 * Fire-and-forget audit log write. Uses the admin (service-role) client so
 * RLS doesn't block the insert from the OTP path. Errors are swallowed —
 * we don't want audit failures to fail the OTP request.
 */
async function writeAudit(
  client: { from: (tbl: string) => { insert: (row: Record<string, unknown>) => Promise<unknown> } } | null,
  row: { merchant_id?: string | null; action: string; payload: Record<string, unknown> },
) {
  if (!client) return;
  try {
    await client.from('audit_log').insert({
      merchant_id: row.merchant_id || null,
      action: row.action,
      payload: row.payload,
    });
  } catch (err) {
    console.warn('[Auth] audit write failed (non-fatal):', err);
  }
}

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
const ALLOW_OTP_FALLBACK = process.env.ALLOW_OTP_FALLBACK === 'true';
// SMS_VERIFICATION_DISABLED — set BYPASS_SMS=false in Railway env to re-enable
const BYPASS_SMS = process.env.BYPASS_SMS === 'true' && process.env.NODE_ENV !== 'production';
const OTP_MIN_INTERVAL_MS = 60_000;
const OTP_WINDOW_MS = 10 * 60 * 1000;
const OTP_MAX_PER_PHONE_WINDOW = 3;
const OTP_MAX_PER_IP_WINDOW = 10;

/** Admin client – used only for DB queries and admin.createUser(). Never for signInWithPassword. */
const adminClient = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

/**
 * Create a throwaway Supabase client for signInWithPassword.
 * Each call gets its own instance so auth state doesn't leak between requests.
 */
function createSignInClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function derivePassword(phone: string): string {
  return createHmac('sha256', SUPABASE_SERVICE_KEY).update(`phone:${phone}`).digest('hex');
}

function phoneToEmail(phone: string): string {
  return `${phone}@phone.nooks.app`;
}

const otpAttemptBuckets = new Map<string, number[]>();

function trackOtpAttempt(key: string, now: number) {
  const current = otpAttemptBuckets.get(key) ?? [];
  const fresh = current.filter((timestamp) => now - timestamp <= OTP_WINDOW_MS);
  fresh.push(now);
  otpAttemptBuckets.set(key, fresh);
  return fresh;
}

function recentOtpAttempts(key: string, now: number) {
  const current = otpAttemptBuckets.get(key) ?? [];
  const fresh = current.filter((timestamp) => now - timestamp <= OTP_WINDOW_MS);
  otpAttemptBuckets.set(key, fresh);
  return fresh;
}

function getRequestIp(req: Request) {
  const forwarded = typeof req.headers['x-forwarded-for'] === 'string'
    ? req.headers['x-forwarded-for'].split(',')[0]?.trim()
    : '';
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

// ─── Send OTP ────────────────────────────────────────────────────────────────

router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    const merchantId =
      typeof req.body?.merchantId === 'string' ? req.body.merchantId.trim() : '';
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId is required for OTP verification' });
    }

    const normalised = normalizePhone(phone.trim());
    if (normalised.length < 12 || !normalised.startsWith('966')) {
      return res.status(400).json({ error: 'Invalid Saudi phone number' });
    }

    if (!adminClient) {
      return res.status(500).json({ error: 'OTP service not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
    }

    const now = Date.now();
    const requestIp = getRequestIp(req);
    const phoneBucketKey = `phone:${merchantId}:${normalised}`;
    const ipBucketKey = `ip:${merchantId}:${requestIp}`;
    const recentPhoneAttempts = recentOtpAttempts(phoneBucketKey, now);
    const recentIpAttempts = recentOtpAttempts(ipBucketKey, now);
    const latestPhoneAttempt = recentPhoneAttempts[recentPhoneAttempts.length - 1];
    if (latestPhoneAttempt && now - latestPhoneAttempt < OTP_MIN_INTERVAL_MS) {
      return res.status(429).json({ error: 'Please wait before requesting another verification code.' });
    }
    if (recentPhoneAttempts.length >= OTP_MAX_PER_PHONE_WINDOW) {
      return res.status(429).json({ error: 'Too many verification attempts for this phone number. Please try again later.' });
    }
    if (recentIpAttempts.length >= OTP_MAX_PER_IP_WINDOW) {
      return res.status(429).json({ error: 'Too many verification attempts from this network. Please try again later.' });
    }

    const { data: latestOtp } = await adminClient
      .from('sms_otp')
      .select('created_at')
      .eq('phone', normalised)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestOtp?.created_at) {
      const latestDbAttempt = new Date(latestOtp.created_at).getTime();
      if (Number.isFinite(latestDbAttempt) && now - latestDbAttempt < OTP_MIN_INTERVAL_MS) {
        return res.status(429).json({ error: 'Please wait before requesting another verification code.' });
      }
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    let walletReservation: { merchantId: string; referenceId: string; amountHalalas: number } | null = null;

    const referenceId = randomUUID();
    const debitResult = await debitMerchantSmsWallet({
      merchantId,
      referenceId,
      phone: normalised,
      note: 'OTP verification SMS',
      metadata: {
        route: 'auth.send-otp',
        phone: normalised,
      },
    });

    if (debitResult.reason === 'merchant_not_found') {
      return res.status(400).json({ error: 'Invalid merchant configuration' });
    }

    if (!debitResult.ok) {
      return res.status(402).json({
        error: 'Verification is temporarily unavailable for this store. Please contact support.',
      });
    }

    if (debitResult.charged) {
      walletReservation = {
        merchantId,
        referenceId,
        amountHalalas: debitResult.chargePerOtpHalalas,
      };
    }

    const { data: insertedOtp, error: insertErr } = await adminClient
      .from('sms_otp')
      .insert({
        phone: normalised,
        code,
        expires_at: expiresAt,
      })
      .select('id')
      .single();
    if (insertErr) {
      if (walletReservation) {
        try {
          await creditMerchantSmsWallet({
            merchantId: walletReservation.merchantId,
            referenceId: `reversal:${walletReservation.referenceId}`,
            amountHalalas: walletReservation.amountHalalas,
            note: 'OTP save failed reversal',
            metadata: {
              original_reference_id: walletReservation.referenceId,
              route: 'auth.send-otp',
            },
          });
        } catch (walletError) {
          // Reversal failed AFTER a successful debit — merchant was charged
          // for an OTP that never got stored. Write to audit_log so we have
          // a queryable trail to reconcile and refund later.
          console.warn('[Auth] OTP save reversal failed:', walletError);
          writeAudit(adminClient, {
            merchant_id: walletReservation.merchantId,
            action: 'sms.reversal_failed',
            payload: {
              stage: 'otp_insert',
              reference_id: walletReservation.referenceId,
              amount_halalas: walletReservation.amountHalalas,
              phone_masked: maskPhone(normalised),
              error: walletError instanceof Error ? walletError.message : String(walletError),
            },
          });
        }
      }
      console.error('[Auth] DB insert error:', insertErr);
      return res.status(500).json({ error: 'Failed to save OTP. Check Supabase config.' });
    }

    const smsResult = await sendSms(normalised, otpMessage(code));

    if (!smsResult.ok) {
      if (walletReservation) {
        try {
          await creditMerchantSmsWallet({
            merchantId: walletReservation.merchantId,
            referenceId: `reversal:${walletReservation.referenceId}`,
            amountHalalas: walletReservation.amountHalalas,
            note: 'SMS send failed reversal',
            metadata: {
              original_reference_id: walletReservation.referenceId,
              route: 'auth.send-otp',
            },
          });
        } catch (walletError) {
          console.warn('[Auth] SMS wallet reversal failed:', walletError);
          writeAudit(adminClient, {
            merchant_id: walletReservation.merchantId,
            action: 'sms.reversal_failed',
            payload: {
              stage: 'sms_send',
              reference_id: walletReservation.referenceId,
              amount_halalas: walletReservation.amountHalalas,
              phone_masked: maskPhone(normalised),
              error: walletError instanceof Error ? walletError.message : String(walletError),
            },
          });
        }
      }
      // Always record the Madar failure in audit_log — this is the single
      // source of truth when diagnosing "why are OTPs not arriving for
      // merchant X". Includes the Madar error code so we can tell sender
      // revocation (ErrorCode tied to sender) from quota/network issues.
      writeAudit(adminClient, {
        merchant_id: merchantId,
        action: 'sms.send_failed',
        payload: {
          phone_masked: maskPhone(normalised),
          sender: process.env.MADAR_SMS_SENDER || 'Nooks',
          madar_status: smsResult.status ?? null,
          madar_error_code: smsResult.errorCode ?? null,
          madar_error: smsResult.error ?? null,
          fallback_enabled: ALLOW_OTP_FALLBACK,
        },
      });
      console.warn('[Auth] SMS send failed:', smsResult.error);
      // Keep the fallback log line — this is how the OTP gets read off
      // Railway logs while the sender is pending re-approval.
      console.log('[Auth] OTP for testing:', normalised, '→', code);
      if (ALLOW_OTP_FALLBACK) {
        trackOtpAttempt(phoneBucketKey, now);
        trackOtpAttempt(ipBucketKey, now);
        return res.json({ ok: true });
      }
      if (insertedOtp?.id) {
        await adminClient.from('sms_otp').delete().eq('id', insertedOtp.id);
      }
      return res.status(500).json({ error: 'Failed to send SMS', detail: smsResult.error });
    }

    if (ALLOW_OTP_FALLBACK) {
      console.log('[Auth] OTP (fallback enabled):', normalised, '→', code);
    }

    trackOtpAttempt(phoneBucketKey, now);
    trackOtpAttempt(ipBucketKey, now);

    res.json({ ok: true });
  } catch (e: unknown) {
    console.error('[Auth] send-otp error:', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to send OTP' });
  }
});

// ─── Verify OTP ──────────────────────────────────────────────────────────────

router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ error: 'Phone and code are required' });
    }

    const normalised = normalizePhone(String(phone).trim());
    const codeStr = String(code).trim();

    if (!adminClient) {
      return res.status(500).json({ error: 'OTP service not configured' });
    }

    // 1. Verify OTP — skipped when BYPASS_SMS=true
    if (!BYPASS_SMS) {
      const { data: otpRow, error: otpErr } = await adminClient
        .from('sms_otp')
        .select('id')
        .eq('phone', normalised)
        .eq('code', codeStr)
        .gte('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (otpErr) {
        console.error('[Auth] verify DB error:', otpErr);
        return res.status(500).json({ error: 'Verification failed. Try again.' });
      }
      if (!otpRow) {
        return res.status(400).json({ error: 'Invalid or expired code' });
      }

      await adminClient.from('sms_otp').delete().eq('id', otpRow.id);
    } else {
      console.log('[Auth] BYPASS_SMS enabled — skipping OTP check for', normalised);
    }

    // 2. Find or create Supabase user for this phone number
    const email = phoneToEmail(normalised);
    const password = derivePassword(normalised);

    // Use a throwaway client for signIn so the shared adminClient auth state stays clean
    const signInClient = createSignInClient();

    // Try signing in first (existing user)
    const { data: signInData } = await signInClient.auth.signInWithPassword({ email, password });

    if (signInData?.session) {
      await ensureProfile(normalised, signInData.session.user.id);
      return res.json({
        ok: true,
        session: {
          access_token: signInData.session.access_token,
          refresh_token: signInData.session.refresh_token,
        },
        user: { id: signInData.session.user.id, phone: `+${normalised}` },
      });
    }

    // User doesn't exist – create with admin API
    const { error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      phone: `+${normalised}`,
      phone_confirm: true,
      email_confirm: true,
      user_metadata: { phone: `+${normalised}` },
    });

    if (createErr) {
      console.error('[Auth] createUser error:', createErr);
      return res.status(500).json({ error: 'Failed to create account' });
    }

    // Sign in the newly created user (fresh client again)
    const freshClient = createSignInClient();
    const { data: newSession, error: newSignInErr } = await freshClient.auth.signInWithPassword({ email, password });

    if (newSignInErr || !newSession?.session) {
      console.error('[Auth] post-create signIn error:', newSignInErr);
      return res.status(500).json({ error: 'Account created but sign-in failed. Try again.' });
    }

    await ensureProfile(normalised, newSession.session.user.id);

    res.json({
      ok: true,
      session: {
        access_token: newSession.session.access_token,
        refresh_token: newSession.session.refresh_token,
      },
      user: { id: newSession.session.user.id, phone: `+${normalised}` },
    });
  } catch (e: unknown) {
    console.error('[Auth] verify-otp error:', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Verification failed' });
  }
});

async function ensureProfile(phone: string, userId: string) {
  if (!adminClient) return;
  try {
    await adminClient.from('profiles').upsert(
      { id: userId, phone_number: `+${phone}`, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );
  } catch (err) {
    console.warn('[Auth] ensureProfile error (non-fatal):', err);
  }
}

export const authRouter = router;
