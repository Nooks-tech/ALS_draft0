/**
 * Auth routes - send & verify email OTP
 */
import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const router = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.OTP_FROM_EMAIL || 'onboarding@resend.dev';
const ALLOW_OTP_FALLBACK = process.env.ALLOW_OTP_FALLBACK === 'true';

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return res.status(400).json({ error: 'Invalid email' });

    if (!supabase) {
      return res.status(500).json({ error: 'OTP service not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    const { error: insertErr } = await supabase.from('email_otp').insert({
      email: trimmed,
      code,
      expires_at: expiresAt,
    });
    if (insertErr) {
      console.error('[Auth] DB insert error:', insertErr);
      return res.status(500).json({ error: 'Failed to save OTP. Check Supabase config.' });
    }

    if (resend) {
      const result = await resend.emails.send({
        from: FROM_EMAIL,
        to: [trimmed],
        subject: 'Your ALS verification code',
        html: `<p>Your verification code is: <strong>${code}</strong></p><p>It expires in 10 minutes.</p>`,
      });
      const { data, error } = result;
      if (error) {
        console.error('[Auth] Resend error:', error);
        console.log('[Auth] OTP for testing:', trimmed, '→', code);
        if (ALLOW_OTP_FALLBACK) {
          res.json({ ok: true });
          return;
        }
        return res.status(500).json({
          error: 'Failed to send email',
          detail: error.message || String(error),
        });
      }
      console.log('[Auth] Resend sent:', { to: trimmed, id: data?.id, from: FROM_EMAIL });
      if (ALLOW_OTP_FALLBACK) {
        console.log('[Auth] OTP (fallback enabled):', trimmed, '→', code);
      }
    } else {
      console.log('[Auth] OTP (no Resend):', trimmed, '→', code);
    }

    res.json({ ok: true });
  } catch (e: unknown) {
    console.error('[Auth] send-otp error:', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to send OTP' });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }
    const trimmed = email.trim().toLowerCase();

    if (!supabase) {
      return res.status(500).json({ error: 'OTP service not configured' });
    }

    const codeStr = String(code).trim();
    const { data, error } = await supabase
      .from('email_otp')
      .select('id')
      .eq('email', trimmed)
      .eq('code', codeStr)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[Auth] verify DB error:', error);
      return res.status(500).json({ error: 'Verification failed. Try again.' });
    }
    if (!data) {
      console.log('[Auth] verify no match:', { email: trimmed, codeLen: codeStr.length });
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    await supabase.from('email_otp').delete().eq('id', data.id);

    res.json({ ok: true });
  } catch (e: unknown) {
    console.error('[Auth] verify-otp error:', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Verification failed' });
  }
});

export const authRouter = router;
