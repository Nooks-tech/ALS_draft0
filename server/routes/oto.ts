/**
 * OTO delivery routes - request driver dispatch when order is placed
 */
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { otoService } from '../services/oto';
import { earnPoints } from './loyalty';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';
import { requireDiagnosticAccess, requireNooksInternalRequest } from '../utils/nooksInternal';
import { hasProcessedWebhookEvent, recordWebhookEvent } from '../utils/webhookIdempotency';
import { webhookRateLimit } from '../utils/rateLimit';

/** Constant-time string comparison; safe to call with strings of any length. */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Verify OTO webhook signature.
 * Per OTO docs, the signature is HMAC-SHA256 of `"orderId:status:timestamp"` (or
 * `"orderId:errorCode:timestamp"` for shipmentError webhooks) signed with the shared
 * webhook secret, and the result is base64-encoded.
 *
 * Falls back to bearer token validation if signature is absent (for backward compat
 * during migration). Returns true if either method authenticates the request.
 */
function verifyOtoWebhook(payload: any, headers: Record<string, any>, query: Record<string, any>): boolean {
  const secret = OTO_WEBHOOK_SECRET || '';
  if (!secret) return false;

  const sig = String(payload?.signature ?? headers['x-oto-signature'] ?? '').trim();
  const orderId = String(payload?.orderId ?? payload?.order_id ?? '').trim();
  const status = String(payload?.status ?? payload?.dcStatus ?? payload?.errorCode ?? '').trim();
  const ts = String(payload?.timestamp ?? '').trim();

  if (sig && orderId && status && ts) {
    const message = `${orderId}:${status}:${ts}`;
    const expected = crypto.createHmac('sha256', secret).update(message).digest('base64');
    if (safeEqual(sig, expected)) return true;
    // Some integrations send hex instead of base64 — try that as a fallback.
    const expectedHex = crypto.createHmac('sha256', secret).update(message).digest('hex');
    if (safeEqual(sig, expectedHex)) return true;
    console.warn('[OTO Webhook] Signature mismatch');
    return false;
  }

  // Legacy fallback: bearer token (for accounts that haven't enabled HMAC yet).
  const token = String(
    (query.secret_token as string) ||
      (headers['authorization'] as string) ||
      (headers['x-oto-secret'] as string) ||
      '',
  ).trim();
  if (!token) return false;
  if (safeEqual(token, secret)) return true;
  if (safeEqual(token, `Bearer ${secret}`)) return true;
  return false;
}

export const otoRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;
const OTO_WEBHOOK_SECRET = process.env.OTO_WEBHOOK_SECRET;
const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

async function sendPushToCustomer(customerId: string, title: string, body: string) {
  if (!supabaseAdmin) return;
  try {
    const { data: subs } = await supabaseAdmin
      .from('push_subscriptions')
      .select('expo_push_token')
      .eq('user_id', customerId);
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

/** Map OTO order status to customer_orders.status (Preparing | Ready | Out for delivery | Delivered | Cancelled) */
export function mapOtoStatusToOrderStatus(otoStatus: string | undefined): string {
  if (!otoStatus) return 'Preparing';
  const s = (otoStatus || '').toLowerCase().replace(/_/g, '');
  if (s.includes('delivered')) return 'Delivered';
  if (s.includes('outfordelivery') || s.includes('deliveryattemptfailed') || s.includes('rescheduled') || s.includes('pickupcompleted') || s.includes('received') || s.includes('arrived')) return 'Out for delivery';
  if (s.includes('pickedup') || s.includes('ready')) return 'Ready';
  if (s.includes('cancelled') || s.includes('canceled')) return 'Cancelled';
  return 'Preparing';
}

export function buildOrderStatusUpdate(mappedStatus: string) {
  const now = new Date().toISOString();
  return {
    status: mappedStatus,
    updated_at: now,
    delivered_at: mappedStatus === 'Delivered' ? now : undefined,
  };
}

/** GET /api/oto/health - verify OTO is configured and auth works */
otoRouter.get('/health', async (req, res) => {
  try {
    if (!requireDiagnosticAccess(req, res)) return;
    const ok = await otoService.healthCheck();
    res.json({ ok, message: ok ? 'OTO connected' : 'OTO health check failed' });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'OTO not configured' });
  }
});

/** GET /api/oto/dc-list - list all delivery companies integrated with OTO (e.g. to check for Careem, Barq, Marsool) */
otoRouter.get('/dc-list', async (req, res) => {
  try {
    if (!requireDiagnosticAccess(req, res)) return;
    const data = await otoService.dcList();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch DC list' });
  }
});

/** GET /api/oto/activated-carriers?city=Madinah - shows which carriers are active on your account for a city */
otoRouter.get('/activated-carriers', async (req, res) => {
  try {
    if (!requireDiagnosticAccess(req, res)) return;
    const city = (req.query.city as string) || undefined;
    const data = await otoService.getActivatedDeliveryOptions(city);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch activated carriers' });
  }
});

/** GET /api/oto/cities?country=SA - list valid city names (use these in delivery-options) */
otoRouter.get('/cities', async (req, res) => {
  try {
    if (!requireDiagnosticAccess(req, res)) return;
    const country = (req.query.country as string) || 'SA';
    const cities = await otoService.getCities(country);
    res.json({ cities });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch cities' });
  }
});

/** GET /api/oto/verify?merchantId=X&city=Madinah - quick setup verification */
otoRouter.get('/verify', async (req, res) => {
  try {
    if (!requireDiagnosticAccess(req, res)) return;
    const merchantId = (req.query.merchantId as string) || undefined;
    const city = (req.query.city as string) || 'Madinah';
    const health = await otoService.healthCheck(merchantId);
    const cities = await otoService.getCities('SA', 20).catch(() => []);
    const options = await otoService
      .getDeliveryOptions({
        originCity: city,
        destinationCity: city,
        weight: 0.5,
        originLat: CITY_COORDS[city]?.lat,
        originLon: CITY_COORDS[city]?.lon,
        destinationLat: CITY_COORDS[city]?.lat,
        destinationLon: CITY_COORDS[city]?.lon,
        merchantId,
      })
      .catch(() => []);
    const activatedDCs = await otoService.getActivatedDeliveryOptions(city).catch(() => null);
    res.json({
      auth: health,
      merchantId: merchantId ?? 'platform (env fallback)',
      sampleCities: cities.slice(0, 10).map((c) => c.name),
      deliveryOptionsCount: options.length,
      sampleOptions: options.map((o) => ({
        carrier: o.deliveryCompanyName,
        option: o.deliveryOptionName,
        price: o.price,
        source: o.source,
        id: o.deliveryOptionId,
      })),
      activatedDCs,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

/** City center coords (for Bullet Delivery - Mrsool needs lat/lon) */
const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
  Riyadh: { lat: 24.7136, lon: 46.6753 },
  Madinah: { lat: 24.4672, lon: 39.6111 },
  Jeddah: { lat: 21.4858, lon: 39.1925 },
  Dammam: { lat: 26.4207, lon: 50.0888 },
};

/** GET /api/oto/delivery-options?merchantId=X&originCity=X&destinationCity=Y&originLat=&originLon=&destinationLat=&destinationLon= - list options. Pass lat/lon for Bullet (Mrsool). Same city = Mrsool eligible. */
otoRouter.get('/delivery-options', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    const merchantId = (req.query.merchantId as string) || undefined;
    const originCity = (req.query.originCity as string) || 'Riyadh';
    const destinationCity = (req.query.destinationCity as string) || 'Riyadh';
    const serviceType = req.query.serviceType as string | undefined;
    const weight = req.query.weight ? Number(req.query.weight) : 1;
    const length = req.query.length ? Number(req.query.length) : 10;
    const width = req.query.width ? Number(req.query.width) : 10;
    const height = req.query.height ? Number(req.query.height) : 10;

    let originLat = req.query.originLat ? Number(req.query.originLat) : undefined;
    let originLon = req.query.originLon ? Number(req.query.originLon) : undefined;
    let destinationLat = req.query.destinationLat ? Number(req.query.destinationLat) : undefined;
    let destinationLon = req.query.destinationLon ? Number(req.query.destinationLon) : undefined;

    if (originLat == null && CITY_COORDS[originCity]) {
      originLat = CITY_COORDS[originCity].lat;
      originLon = CITY_COORDS[originCity].lon;
    }
    if (destinationLat == null && CITY_COORDS[destinationCity]) {
      destinationLat = CITY_COORDS[destinationCity].lat;
      destinationLon = CITY_COORDS[destinationCity].lon;
    }

    const options = await otoService.getDeliveryOptions({
      originCity,
      destinationCity,
      weight,
      length,
      width,
      height,
      serviceType: serviceType as any,
      originLat,
      originLon,
      destinationLat,
      destinationLon,
      merchantId,
    });
    res.json({ options, serviceType });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch delivery options' });
  }
});

/** GET /api/oto/order-status?otoId=123 - OTO order details via GET /orderDetails (driver position, tracking). Syncs status to Supabase customer_orders when oto_id matches. */
otoRouter.get('/order-status', async (req, res) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    const otoIdRaw = req.query.otoId ?? req.query.orderId;
    if (otoIdRaw == null) {
      return res.status(400).json({ error: 'Missing otoId or orderId query param' });
    }
    const otoId = Number(otoIdRaw);
    if (isNaN(otoId)) {
      return res.status(400).json({ error: 'otoId must be numeric' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const lookupId = otoId;
    let merchantId: string | null = null;
    const { data: order } = await supabaseAdmin
      .from('customer_orders')
      .select('merchant_id, customer_id')
      .eq('oto_id', otoId)
      .maybeSingle();
    if (!order || order.customer_id !== user.id) {
      return res.status(404).json({ error: 'Order not found' });
    }
    merchantId = order?.merchant_id ?? null;
    const status = await otoService.orderStatus(lookupId, merchantId);
    const mappedStatus = mapOtoStatusToOrderStatus(status?.status);
    if (supabaseAdmin && mappedStatus !== 'Preparing' && !isNaN(otoId)) {
      const baseUpdate = buildOrderStatusUpdate(mappedStatus);
      const updatePayload: Record<string, unknown> = {
        status: baseUpdate.status,
        updated_at: baseUpdate.updated_at,
      };
      if (baseUpdate.delivered_at) updatePayload.delivered_at = baseUpdate.delivered_at;
      if (status.driverLat != null) updatePayload.driver_lat = status.driverLat;
      if (status.driverLon != null) updatePayload.driver_lng = status.driverLon;
      const { error } = await supabaseAdmin
        .from('customer_orders')
        .update(updatePayload)
        .eq('oto_id', otoId);
      if (error) console.warn('[OTO] Supabase status sync failed:', error.message);
    }
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get order status' });
  }
});

/**
 * POST /api/oto/webhook – OTO pushes order status changes here.
 * Payload: { orderId, status, driverName, driverPhone, trackingNumber, deliveryCompany, timestamp, signature }
 */
otoRouter.post('/webhook', webhookRateLimit, async (req, res) => {
  try {
    if (!OTO_WEBHOOK_SECRET) {
      return res.status(503).json({ error: 'OTO webhook secret is not configured' });
    }

    const payload = req.body || {};
    if (!verifyOtoWebhook(payload, req.headers as Record<string, any>, req.query as Record<string, any>)) {
      console.warn('[OTO Webhook] Authentication failed');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const otoOrderId = payload.orderId ?? payload.order_id;
    const otoStatus = payload.status ?? payload.dcStatus;
    const driverName = payload.driverName;
    const driverPhone = payload.driverPhone;
    const trackingNumber = payload.trackingNumber;
    const pickupLocationCode = payload.pickupLocationCode ?? payload.pickup_location_code;

    console.log('[OTO Webhook]', { otoOrderId, otoStatus, driverName, trackingNumber, pickupLocationCode });

    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
    if (!otoOrderId) return res.status(400).json({ error: 'Missing oto order id' });

    // Idempotency: dedupe OTO retries.
    const eventId = `${otoOrderId}:${otoStatus ?? ''}:${payload.timestamp ?? ''}`;
    if (await hasProcessedWebhookEvent('oto', eventId)) {
      console.log('[OTO Webhook] Duplicate event, skipping:', eventId);
      return res.json({ received: true, duplicate: true });
    }

    const mappedStatus = mapOtoStatusToOrderStatus(otoStatus);

    // Resolve merchant scope from the pickup location code (which maps to a branch).
    // This prevents an attacker who guessed an OTO order ID from updating another merchant's order.
    let scopedMerchantId: string | null = null;
    if (pickupLocationCode) {
      const { data: branchRow } = await supabaseAdmin
        .from('branch_mappings')
        .select('merchant_id')
        .eq('oto_warehouse_id', pickupLocationCode)
        .maybeSingle();
      scopedMerchantId = (branchRow as { merchant_id?: string } | null)?.merchant_id ?? null;
    }

    // Find the order by oto_id (scoped to merchant when we know it).
    const numericId = Number(otoOrderId);
    let lookup = supabaseAdmin
      .from('customer_orders')
      .select('id, status, customer_id, order_type, total_sar, merchant_id')
      .eq('oto_id', isNaN(numericId) ? otoOrderId : numericId);
    if (scopedMerchantId) {
      lookup = lookup.eq('merchant_id', scopedMerchantId);
    }
    const { data: order, error: orderLookupError } = await lookup.maybeSingle();

    if (orderLookupError) {
      console.error('[OTO Webhook] Order lookup failed:', orderLookupError.message);
      return res.status(500).json({ error: 'Failed to resolve delivery order' });
    }
    if (!order) {
      console.warn('[OTO Webhook] No order found for oto_id:', otoOrderId);
      return res.status(409).json({ error: 'Order not found for oto webhook' });
    }

    // Don't regress status (e.g. don't go from Delivered back to Out for delivery)
    const STATUS_RANK: Record<string, number> = {
      'Pending': 0, 'Preparing': 1, 'Ready': 2, 'Out for delivery': 3, 'Delivered': 4, 'Cancelled': 5,
    };
    const currentRank = STATUS_RANK[order.status] ?? 0;
    const newRank = STATUS_RANK[mappedStatus] ?? 0;
    if (newRank <= currentRank && mappedStatus !== 'Cancelled') {
      console.log('[OTO Webhook] Skipping status regression:', order.status, '->', mappedStatus);
      return res.json({ received: true, skipped: true, currentStatus: order.status });
    }

    const baseUpdate = buildOrderStatusUpdate(mappedStatus);
    const updates: Record<string, unknown> = {
      status: baseUpdate.status,
      updated_at: baseUpdate.updated_at,
    };
    if (baseUpdate.delivered_at) {
      updates.delivered_at = baseUpdate.delivered_at;
    }
    // Persist driver info from OTO webhook for delivery tracking UI
    if (driverName) updates.driver_name = driverName;
    if (driverPhone) updates.driver_phone = driverPhone;

    const { error: updateErr } = await supabaseAdmin
      .from('customer_orders')
      .update(updates)
      .eq('id', order.id)
      .eq('merchant_id', order.merchant_id);

    if (updateErr) {
      console.error('[OTO Webhook] DB update failed:', updateErr.message);
      return res.status(500).json({ error: 'Failed to persist delivery status' });
    }

    // Push notifications for key transitions
    if (mappedStatus === 'Out for delivery' && order.customer_id) {
      sendPushToCustomer(
        order.customer_id,
        'Order On The Way!',
        `Your order is out for delivery${driverName ? ` with ${driverName}` : ''}.`,
      );
    } else if (mappedStatus === 'Delivered' && order.customer_id) {
      sendPushToCustomer(
        order.customer_id,
        'Order Delivered',
        'Your order has been delivered. Enjoy!',
      );
      earnPoints(order.customer_id, order.id, order.total_sar ?? 0, order.merchant_id ?? '').catch(
        (e: any) => console.warn('[OTO Webhook] Auto-earn loyalty failed:', e?.message),
      );
    } else if (mappedStatus === 'Cancelled' && order.customer_id) {
      sendPushToCustomer(
        order.customer_id,
        'Delivery Cancelled',
        'The delivery for your order has been cancelled. Please contact support.',
      );
    }

    await recordWebhookEvent('oto', eventId, {
      orderId: order.id,
      otoOrderId: String(otoOrderId),
      newStatus: mappedStatus,
      merchantId: order.merchant_id,
    });
    res.json({ received: true, orderId: order.id, newStatus: mappedStatus });
  } catch (err: any) {
    console.error('[OTO Webhook] Error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to process oto webhook' });
  }
});

/**
 * POST /api/oto/create-pickup — create an OTO pickup location (warehouse)
 * for a branch, scoped to the merchant's own OTO account. nooksweb calls
 * this from its Foodics sync so every synced branch gets a matching OTO
 * warehouse automatically.
 *
 * Body: { merchantId?, code, name, city, address?, contactName?, contactEmail?, contactPhone?, lat?, lon? }
 */
otoRouter.post('/create-pickup', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;

    const { merchantId, code, name, city, address, contactName, contactEmail, contactPhone, lat, lon } = req.body;
    if (!code || !name || !city) {
      return res.status(400).json({ error: 'code, name, and city are required' });
    }
    const result = await otoService.createPickupLocation({
      merchantId: typeof merchantId === 'string' ? merchantId.trim() || null : null,
      code,
      name,
      mobile: contactPhone || '500000000',
      address: address || name,
      city,
      country: 'SA',
      contactName: contactName || name,
      contactEmail: contactEmail || 'merchant@nooks.sa',
      type: 'branch',
      lat,
      lon,
      status: 'active',
    });
    console.log('[OTO] Pickup location created:', { merchantId, code, success: result.success, pickupLocationCode: result.pickupLocationCode });
    res.json(result);
  } catch (err: any) {
    console.error('[OTO] create-pickup error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to create pickup location' });
  }
});

otoRouter.post('/request-delivery', async (req, res) => {
  console.log('[OTO] request-delivery received');
  try {
    // Accept either: user auth (app checkout) OR internal secret (Foodics webhook via nooksweb)
    const hasInternalSecret = req.headers['x-nooks-internal-secret'] === (process.env.NOOKS_INTERNAL_SECRET || '').trim();
    let authUserId: string | null = null;
    if (!hasInternalSecret) {
      const user = await requireAuthenticatedAppUser(req, res);
      if (!user) return;
      authUserId = user.id;
    }
    const {
      orderId,
      amount,
      merchantId,
      customer,
      deliveryAddress,
      branch,
      items,
    } = req.body;
    const scopedMerchantId = typeof merchantId === 'string' ? merchantId.trim() : '';

    if (!orderId || !amount || !customer?.name || !customer?.phone || !deliveryAddress?.address || !branch?.name || !items?.length) {
      return res.status(400).json({
        error: 'Missing required fields: orderId, amount, customer (name, phone), deliveryAddress, branch, items',
      });
    }
    if (!scopedMerchantId) {
      return res.status(400).json({ error: 'merchantId is required for delivery dispatch' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const normalizedOrderId = String(orderId);
    let orderQuery = supabaseAdmin
      .from('customer_orders')
      .select('id, merchant_id, customer_id, total_sar, status, order_type, payment_id')
      .eq('id', normalizedOrderId)
      .eq('merchant_id', scopedMerchantId);
    // Only filter by customer_id when called from app (not from nooksweb internal)
    if (authUserId) {
      orderQuery = orderQuery.eq('customer_id', authUserId);
    }
    const { data: order, error: orderError } = await orderQuery.maybeSingle();
    if (orderError) {
      return res.status(500).json({ error: orderError.message });
    }
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.order_type !== 'delivery') {
      return res.status(400).json({ error: 'Delivery dispatch is only allowed for delivery orders' });
    }
    if (!order.payment_id) {
      return res.status(400).json({ error: 'Delivery dispatch requires a paid order' });
    }
    if (order.status === 'Cancelled' || order.status === 'Delivered') {
      return res.status(400).json({ error: `Cannot dispatch delivery for order status: ${order.status}` });
    }
    if (Math.abs(Number(order.total_sar ?? 0) - Number(amount)) > 0.01) {
      return res.status(400).json({ error: 'Dispatch amount does not match the stored order total' });
    }

    const result = await otoService.requestDelivery({
      orderId: normalizedOrderId,
      amount: Number(amount),
      merchantId: scopedMerchantId,
      pickupLocationCode: req.body.pickupLocationCode || undefined,
      deliveryOptionId: req.body.deliveryOptionId != null ? Number(req.body.deliveryOptionId) : undefined,
      customer: {
        name: String(customer.name),
        phone: String(customer.phone),
        email: customer.email,
      },
      deliveryAddress: {
        address: String(deliveryAddress.address),
        lat: deliveryAddress.lat,
        lng: deliveryAddress.lng,
        city: deliveryAddress.city,
      },
      branch: {
        name: String(branch.name),
        address: branch.address,
      },
      items: items.map((i: any) => ({
        name: String(i.name || 'Item'),
        price: Number(i.price || 0),
        quantity: Number(i.quantity || 1),
      })),
    });

    const carrierName = req.body.carrierName ?? 'unknown';
    console.log('[OTO] Delivery requested:', { userId: authUserId, orderId, merchantId: scopedMerchantId, otoId: result?.otoId, success: result?.success, deliveryOptionId: req.body.deliveryOptionId, carrier: carrierName });
    res.json(result);
  } catch (err: any) {
    console.error('[OTO] request-delivery error:', err?.message);
    res.status(500).json({
      error: err?.message || 'Failed to request delivery',
    });
  }
});

/** POST /api/oto/register-webhook – Register this server's webhook URL with OTO */
otoRouter.post('/register-webhook', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;

    const baseUrl = (req.body.baseUrl || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
    const webhookUrl = `${baseUrl}/api/oto/webhook`;
    const merchantId = typeof req.body?.merchantId === 'string' ? req.body.merchantId.trim() : undefined;
    const result = await otoService.registerWebhook(webhookUrl, 'orderStatus', merchantId);
    console.log('[OTO] Webhook registration:', { webhookUrl, result });
    res.json({ ...result, webhookUrl });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to register webhook' });
  }
});
