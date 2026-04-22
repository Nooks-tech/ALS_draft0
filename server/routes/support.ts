import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';

export const supportRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPPORT_SLACK_WEBHOOK = (process.env.SUPPORT_SLACK_WEBHOOK || '').trim();
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || '').trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const RESEND_FROM = (process.env.RESEND_FROM_EMAIL || '').trim();

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

async function notifySupportChannels(payload: {
  ticketId: string;
  subject: string;
  message: string;
  email: string | null;
  merchantId: string | null;
  customerId: string;
}): Promise<void> {
  // Slack first — fast and easy to triage from. Fire-and-forget both.
  if (SUPPORT_SLACK_WEBHOOK) {
    fetch(SUPPORT_SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `:speech_balloon: *New support ticket* — ${payload.subject}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${payload.subject}*\n${payload.message.slice(0, 1500)}\n\nTicket ID: \`${payload.ticketId}\`\nFrom: ${payload.email ?? payload.customerId}\nMerchant: ${payload.merchantId ?? '—'}`,
            },
          },
        ],
      }),
    }).catch((e) => console.warn('[Support] slack notify failed:', e?.message));
  }
  if (SUPPORT_EMAIL && RESEND_API_KEY && RESEND_FROM) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [SUPPORT_EMAIL],
        reply_to: payload.email ?? undefined,
        subject: `[Nooks Support] ${payload.subject}`,
        text:
          `New ticket ${payload.ticketId}\n\n` +
          `From: ${payload.email ?? payload.customerId}\n` +
          `Merchant: ${payload.merchantId ?? '—'}\n\n` +
          payload.message,
      }),
    }).catch((e) => console.warn('[Support] email notify failed:', e?.message));
  }
}

supportRouter.post('/', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const merchantId =
      typeof req.body?.merchantId === 'string' && req.body.merchantId.trim()
        ? req.body.merchantId.trim()
        : null;

    if (!subject || !message) {
      return res.status(400).json({ error: 'subject and message are required' });
    }

    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .insert({
        merchant_id: merchantId,
        customer_id: user.id,
        email: user.email ?? null,
        subject,
        message,
      })
      .select('id, created_at')
      .single();

    if (error || !data) {
      return res.status(500).json({ error: error?.message || 'Failed to create support ticket' });
    }

    // Fan out to Slack + email so the ticket actually gets seen.
    await notifySupportChannels({
      ticketId: data.id,
      subject,
      message,
      email: user.email ?? null,
      merchantId,
      customerId: user.id,
    });

    res.status(201).json({ success: true, ticketId: data.id, createdAt: data.created_at });
  } catch (err: any) {
    console.error('[Support] create ticket error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to create support ticket' });
  }
});
