/**
 * Order complaints – customer submit, merchant review/resolve, list.
 * Includes abuse prevention (1 per order, flagged accounts).
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { cancelPayment } from '../services/payment';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';
import { requireNooksInternalRequest } from '../utils/nooksInternal';

export const complaintsRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

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
        to: t, sound: 'default', title, body, channelId: 'marketing',
      }))),
    });
  } catch { /* best-effort */ }
}

const COMPLAINT_WINDOW_HOURS = 24;
const ABUSE_THRESHOLD_PERCENT = 30;
const ABUSE_LOOKBACK_ORDERS = 20;

/* ═══════════════════════════════════════════════════════════════════
   CUSTOMER: Submit complaint
   POST /api/complaints/:orderId
   ═══════════════════════════════════════════════════════════════════ */
complaintsRouter.post('/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { complaint_type, description, photo_urls, items, customer_id } = req.body;

    if (!complaint_type) return res.status(400).json({ error: 'complaint_type is required' });
    if (!customer_id) return res.status(400).json({ error: 'customer_id is required' });
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });
    if (customer_id !== user.id) {
      return res.status(403).json({ error: 'Forbidden - complaint customer does not match authenticated user' });
    }

    // Fetch the order
    const { data: order, error: fetchErr } = await supabaseAdmin
      .from('customer_orders')
      .select('*')
      .eq('id', orderId)
      .eq('customer_id', user.id)
      .single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'Delivered') {
      return res.status(400).json({ error: 'Complaints can only be filed for delivered orders' });
    }

    // 24-hour window check
    const deliveredSource = order.delivered_at || order.updated_at;
    const deliveredAt = new Date(deliveredSource).getTime();
    if (Date.now() - deliveredAt > COMPLAINT_WINDOW_HOURS * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'Complaint window has expired (24 hours after delivery)' });
    }

    // 1 complaint per order
    const { data: existing } = await supabaseAdmin
      .from('order_complaints')
      .select('id')
      .eq('order_id', orderId)
      .limit(1);
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: 'A complaint has already been filed for this order' });
    }

    // Abuse flagging: check complaint rate for this customer
    let flagged = false;
    const { data: recentOrders } = await supabaseAdmin
      .from('customer_orders')
      .select('id')
      .eq('customer_id', customer_id)
      .eq('status', 'Delivered')
      .order('created_at', { ascending: false })
      .limit(ABUSE_LOOKBACK_ORDERS);

    if (recentOrders && recentOrders.length >= 5) {
      const orderIds = recentOrders.map((o: any) => o.id);
      const { count } = await supabaseAdmin
        .from('order_complaints')
        .select('id', { count: 'exact', head: true })
        .in('order_id', orderIds);
      const complaintRate = ((count ?? 0) / recentOrders.length) * 100;
      if (complaintRate >= ABUSE_THRESHOLD_PERCENT) {
        flagged = true;
      }
    }

    // Calculate requested refund from selected items
    let requestedRefundAmount: number | null = null;
    if (items && Array.isArray(items) && items.length > 0) {
      requestedRefundAmount = items.reduce(
        (sum: number, item: { price?: number; quantity?: number }) =>
          sum + (item.price ?? 0) * (item.quantity ?? 1),
        0,
      );
    }

    // Auto-compute liability based on complaint type
    const LIABILITY_MAP: Record<string, string | null> = {
      missing_item: 'store',
      wrong_item: 'store',
      quality_issue: 'store',
      damaged_packaging: 'fleet',
      late_delivery: 'fleet',
      tampered: 'fleet',
      other: null,
    };
    const suggestedLiability = LIABILITY_MAP[complaint_type] ?? null;

    const { data: complaint, error: insertErr } = await supabaseAdmin
      .from('order_complaints')
      .insert({
        order_id: orderId,
        merchant_id: order.merchant_id,
        customer_id,
        complaint_type,
        description: description || null,
        photo_urls: photo_urls || [],
        items: items || [],
        requested_refund_amount: requestedRefundAmount,
        suggested_liability: suggestedLiability,
        flagged,
      })
      .select()
      .single();

    if (insertErr) return res.status(500).json({ error: insertErr.message });

    // TODO: Push notification to merchant (needs merchant push token infrastructure)
    console.log(`[Complaints] New complaint ${complaint.id} for order ${orderId}`, { flagged });

    res.json({ success: true, complaint });
  } catch (err: any) {
    console.error('[Complaints] Submit error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to submit complaint' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   MERCHANT: List complaints
   GET /api/complaints?merchant_id=X&status=pending
   ═══════════════════════════════════════════════════════════════════ */
complaintsRouter.get('/', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;

    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const merchantId = req.query.merchant_id as string;
    if (!merchantId) return res.status(400).json({ error: 'merchant_id is required' });

    let query = supabaseAdmin
      .from('order_complaints')
      .select('*, customer_orders!inner(id, total_sar, items, customer_id, branch_name, branch_id)')
      .eq('merchant_id', merchantId)
      .order('created_at', { ascending: false });

    const statusFilter = req.query.status as string;
    if (statusFilter) query = query.eq('status', statusFilter);

    const { data, error } = await query.limit(100);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ complaints: data ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to list complaints' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   MERCHANT: Resolve complaint (approve with partial refund or reject)
   POST /api/complaints/:complaintId/resolve
   ═══════════════════════════════════════════════════════════════════ */
complaintsRouter.post('/:complaintId/resolve', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;

    const { complaintId } = req.params;
    const { action, approved_refund_amount, merchant_notes } = req.body;

    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });
    if (!action || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be "approve" or "reject"' });
    }

    const { data: complaint, error: fetchErr } = await supabaseAdmin
      .from('order_complaints')
      .select('*')
      .eq('id', complaintId)
      .single();

    if (fetchErr || !complaint) return res.status(404).json({ error: 'Complaint not found' });
    if (complaint.status !== 'pending') {
      return res.status(400).json({ error: `Complaint already resolved: ${complaint.status}` });
    }

    // Fetch the parent order for payment_id
    const { data: order } = await supabaseAdmin
      .from('customer_orders')
      .select('payment_id, total_sar, customer_id, merchant_id')
      .eq('id', complaint.order_id)
      .single();

    if (action === 'reject') {
      await supabaseAdmin
        .from('order_complaints')
        .update({
          status: 'rejected',
          merchant_notes: merchant_notes || null,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', complaintId);

      if (order) {
        sendPush(
          order.customer_id,
          'Complaint Update',
          `Your complaint for order #${complaint.order_id.replace('order-', '')} was not approved. Please contact support if you disagree.`,
        );
      }

      return res.json({ success: true, status: 'rejected' });
    }

    // Approve → partial refund
    const refundSAR = approved_refund_amount != null
      ? Math.min(Number(approved_refund_amount), order?.total_sar ?? Infinity)
      : complaint.requested_refund_amount ?? 0;

    if (refundSAR <= 0) {
      return res.status(400).json({ error: 'approved_refund_amount must be > 0' });
    }

    let refundId: string | null = null;
    let refundFee = 0;
    let refundMethod: string | null = null;
    let complaintStatus = 'approved';

    if (order?.payment_id) {
      const amountHalals = Math.round(refundSAR * 100);
      const result = await cancelPayment(order.payment_id, amountHalals, order.merchant_id);
      if (result.method === 'failed') {
        complaintStatus = 'approved'; // approved but refund failed — logged
        console.error('[Complaints] Refund failed for complaint', complaintId, result.error);
      } else {
        complaintStatus = 'refunded';
        refundId = result.moyasarId ?? null;
        refundFee = result.fee;
        refundMethod = result.method;
      }
    }

    await supabaseAdmin
      .from('order_complaints')
      .update({
        status: complaintStatus,
        approved_refund_amount: refundSAR,
        merchant_notes: merchant_notes || null,
        refund_id: refundId,
        refund_method: refundMethod,
        refund_fee: refundFee,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', complaintId);

    if (order) {
      sendPush(
        order.customer_id,
        'Refund Approved',
        `Your complaint for order #${complaint.order_id.replace('order-', '')} has been approved. A refund of ${refundSAR} SAR has been initiated.`,
      );
    }

    res.json({ success: true, status: complaintStatus, refundAmount: refundSAR, refundFee, refundMethod });
  } catch (err: any) {
    console.error('[Complaints] Resolve error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to resolve complaint' });
  }
});

/** POST /api/complaints/upload – Upload complaint photo (base64 payload)
 * Body: { image: "data:image/jpeg;base64,..." OR raw base64, filename?: "photo.jpg" }
 * Returns: { url: "https://..." } - public Supabase storage URL
 */
complaintsRouter.post('/upload', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

    const { image, filename } = req.body;
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'image (base64) is required' });
    }

    // Strip data URI prefix if present
    const base64Match = image.match(/^data:image\/([\w+]+);base64,(.+)$/);
    const mimeExt = base64Match ? base64Match[1].replace('+', '') : 'jpeg';
    const raw = base64Match ? base64Match[2] : image;
    const buffer = Buffer.from(raw, 'base64');

    // Max 5MB
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(413).json({ error: 'Image too large. Maximum 5MB.' });
    }

    const safeName = (filename || `complaint-${Date.now()}.${mimeExt}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `complaints/${user.id}/${safeName}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('complaint-images')
      .upload(storagePath, buffer, {
        contentType: `image/${mimeExt}`,
        upsert: true,
      });

    if (uploadError) {
      console.error('[Complaints] Upload error:', uploadError.message);
      return res.status(500).json({ error: 'Failed to upload image' });
    }

    const { data: publicUrl } = supabaseAdmin.storage
      .from('complaint-images')
      .getPublicUrl(storagePath);

    res.json({ url: publicUrl.publicUrl });
  } catch (err: any) {
    console.error('[Complaints] Upload error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to upload' });
  }
});
