/**
 * Auth routes – SMS OTP via MadarSMS + Supabase user management
 *
 * Flow:
 *  1. POST /send-otp { phone } → generate code, store in sms_otp, send via MadarSMS
 *  2. POST /verify-otp { phone, code } → verify code, find-or-create Supabase user,
 *     return session tokens so the client can call supabase.auth.setSession()
 */
import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'crypto';
import { sendSms, normalizePhone } from '../services/sms';

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
const ALLOW_OTP_FALLBACK = process.env.ALLOW_OTP_FALLBACK === 'true';
// SMS_VERIFICATION_DISABLED — set BYPASS_SMS=false in Railway env to re-enable
const BYPASS_SMS = process.env.BYPASS_SMS === 'true' && process.env.NODE_ENV !== 'production';

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

// ─── Send OTP ────────────────────────────────────────────────────────────────

router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const normalised = normalizePhone(phone.trim());
    if (normalised.length < 12 || !normalised.startsWith('966')) {
      return res.status(400).json({ error: 'Invalid Saudi phone number' });
    }

    if (!adminClient) {
      return res.status(500).json({ error: 'OTP service not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: insertErr } = await adminClient.from('sms_otp').insert({
      phone: normalised,
      code,
      expires_at: expiresAt,
    });
    if (insertErr) {
      console.error('[Auth] DB insert error:', insertErr);
      return res.status(500).json({ error: 'Failed to save OTP. Check Supabase config.' });
    }

    const smsResult = await sendSms(normalised, `Your verification code is: ${code}`);

    if (!smsResult.ok) {
      console.warn('[Auth] SMS send failed:', smsResult.error);
      console.log('[Auth] OTP for testing:', normalised, '→', code);
      if (ALLOW_OTP_FALLBACK) {
        return res.json({ ok: true });
      }
      return res.status(500).json({ error: 'Failed to send SMS', detail: smsResult.error });
    }

    if (ALLOW_OTP_FALLBACK) {
      console.log('[Auth] OTP (fallback enabled):', normalised, '→', code);
    }

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
