import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';

export const supportRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

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

    res.status(201).json({ success: true, ticketId: data.id, createdAt: data.created_at });
  } catch (err: any) {
    console.error('[Support] create ticket error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to create support ticket' });
  }
});
