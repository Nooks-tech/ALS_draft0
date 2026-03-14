/**
 * OTO delivery routes - request driver dispatch when order is placed
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { otoService } from '../services/oto';
import { earnPoints } from './loyalty';

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
function mapOtoStatusToOrderStatus(otoStatus: string | undefined): string {
  if (!otoStatus) return 'Preparing';
  const s = (otoStatus || '').toLowerCase().replace(/_/g, '');
  if (s.includes('delivered')) return 'Delivered';
  if (s.includes('outfordelivery')) return 'Out for delivery';
  if (s.includes('pickedup') || s.includes('ready')) return 'Ready';
  if (s.includes('cancelled') || s.includes('canceled')) return 'Cancelled';
  return 'Preparing';
}

/** GET /api/oto/health - verify OTO is configured and auth works */
otoRouter.get('/health', async (_req, res) => {
  try {
    const ok = await otoService.healthCheck();
    res.json({ ok, message: ok ? 'OTO connected' : 'OTO health check failed' });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'OTO not configured' });
  }
});

/** GET /api/oto/dc-list - list all delivery companies integrated with OTO (e.g. to check for Careem, Barq, Marsool) */
otoRouter.get('/dc-list', async (_req, res) => {
  try {
    const data = await otoService.dcList();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch DC list' });
  }
});

/** GET /api/oto/activated-carriers?city=Madinah - shows which carriers are active on your account for a city */
otoRouter.get('/activated-carriers', async (req, res) => {
  try {
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
    const country = (req.query.country as string) || 'SA';
    const cities = await otoService.getCities(country);
    res.json({ cities });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch cities' });
  }
});

/** GET /api/oto/verify - quick setup verification */
otoRouter.get('/verify', async (req, res) => {
  try {
    const city = (req.query.city as string) || 'Madinah';
    const health = await otoService.healthCheck();
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
      })
      .catch(() => []);
    const activatedDCs = await otoService.getActivatedDeliveryOptions(city).catch(() => null);
    res.json({
      auth: health,
      pickupLocationCode: process.env.OTO_PICKUP_LOCATION_CODE ? '✓ set' : '✗ missing',
      preferredCarriers: process.env.OTO_PREFERRED_CARRIERS || 'careem,mrsool,barq (default)',
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

/** GET /api/oto/delivery-options?originCity=X&destinationCity=Y&originLat=&originLon=&destinationLat=&destinationLon= - list options. Pass lat/lon for Bullet (Mrsool). Same city = Mrsool eligible. */
otoRouter.get('/delivery-options', async (req, res) => {
  try {
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
    });
    res.json({ options, serviceType });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch delivery options' });
  }
});

/** GET /api/oto/order-status?otoId=123 - OTO order details via GET /orderDetails (driver position, tracking). Syncs status to Supabase customer_orders when oto_id matches. */
otoRouter.get('/order-status', async (req, res) => {
  try {
    const otoIdRaw = req.query.otoId ?? req.query.orderId;
    if (otoIdRaw == null) {
      return res.status(400).json({ error: 'Missing otoId or orderId query param' });
    }
    const otoId = Number(otoIdRaw);
    const lookupId = isNaN(otoId) ? String(otoIdRaw) : otoId;
    const status = await otoService.orderStatus(lookupId);
    const mappedStatus = mapOtoStatusToOrderStatus(status?.status);
    if (supabaseAdmin && mappedStatus !== 'Preparing' && !isNaN(otoId)) {
      const updatePayload: Record<string, unknown> = { status: mappedStatus, updated_at: new Date().toISOString() };
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
otoRouter.post('/webhook', async (req, res) => {
  try {
    if (OTO_WEBHOOK_SECRET) {
      const token =
        (req.query.secret_token as string) ||
        req.headers['authorization'] as string ||
        req.headers['x-oto-secret'] as string;
      if (token !== OTO_WEBHOOK_SECRET && token !== `Bearer ${OTO_WEBHOOK_SECRET}`) {
        console.warn('[OTO Webhook] Invalid secret token');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const payload = req.body;
    const otoOrderId = payload.orderId ?? payload.order_id;
    const otoStatus = payload.status ?? payload.dcStatus;
    const driverName = payload.driverName;
    const driverPhone = payload.driverPhone;
    const trackingNumber = payload.trackingNumber;

    console.log('[OTO Webhook]', { otoOrderId, otoStatus, driverName, trackingNumber });

    if (!supabaseAdmin || !otoOrderId) return res.json({ received: true });

    const mappedStatus = mapOtoStatusToOrderStatus(otoStatus);

    // Find the order by oto_id
    const numericId = Number(otoOrderId);
    const { data: order } = await supabaseAdmin
      .from('customer_orders')
      .select('id, status, customer_id, order_type, total_sar, merchant_id')
      .eq('oto_id', isNaN(numericId) ? otoOrderId : numericId)
      .single();

    if (!order) {
      console.warn('[OTO Webhook] No order found for oto_id:', otoOrderId);
      return res.json({ received: true, matched: false });
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

    const updates: Record<string, unknown> = {
      status: mappedStatus,
      updated_at: new Date().toISOString(),
    };

    const { error: updateErr } = await supabaseAdmin
      .from('customer_orders')
      .update(updates)
      .eq('id', order.id);

    if (updateErr) {
      console.error('[OTO Webhook] DB update failed:', updateErr.message);
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

    res.json({ received: true, orderId: order.id, newStatus: mappedStatus });
  } catch (err: any) {
    console.error('[OTO Webhook] Error:', err?.message);
    res.json({ received: true, error: err?.message });
  }
});

/** POST /api/oto/create-pickup – Create an OTO pickup location for a branch */
otoRouter.post('/create-pickup', async (req, res) => {
  try {
    const { code, name, city, address, contactName, contactEmail, contactPhone, lat, lon } = req.body;
    if (!code || !name || !city) {
      return res.status(400).json({ error: 'code, name, and city are required' });
    }
    const result = await otoService.createPickupLocation({
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
    console.log('[OTO] Pickup location created:', { code, success: result.success, pickupLocationCode: result.pickupLocationCode });
    res.json(result);
  } catch (err: any) {
    console.error('[OTO] create-pickup error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to create pickup location' });
  }
});

otoRouter.post('/request-delivery', async (req, res) => {
  console.log('[OTO] request-delivery received');
  try {
    const {
      orderId,
      amount,
      customer,
      deliveryAddress,
      branch,
      items,
    } = req.body;

    if (!orderId || !amount || !customer?.name || !customer?.phone || !deliveryAddress?.address || !branch?.name || !items?.length) {
      return res.status(400).json({
        error: 'Missing required fields: orderId, amount, customer (name, phone), deliveryAddress, branch, items',
      });
    }

    const result = await otoService.requestDelivery({
      orderId: String(orderId),
      amount: Number(amount),
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

    const optId = req.body.deliveryOptionId ?? process.env.OTO_DELIVERY_OPTION_ID;
    const carrierName = req.body.carrierName ?? 'unknown';
    console.log('[OTO] Delivery requested:', { orderId, otoId: result?.otoId, success: result?.success, deliveryOptionId: optId, carrier: carrierName });
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
    const baseUrl = (req.body.baseUrl || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
    const webhookUrl = `${baseUrl}/api/oto/webhook`;
    const result = await otoService.registerWebhook(webhookUrl, 'orderStatus');
    console.log('[OTO] Webhook registration:', { webhookUrl, result });
    res.json({ ...result, webhookUrl });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to register webhook' });
  }
});
