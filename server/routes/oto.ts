/**
 * OTO delivery routes - request driver dispatch when order is placed
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { otoService } from '../services/oto';

export const otoRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

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
otoRouter.get('/verify', async (_req, res) => {
  try {
    const health = await otoService.healthCheck();
    const cities = await otoService.getCities('SA', 20).catch(() => []);
    const options = await otoService
      .getDeliveryOptions({ originCity: 'Madinah', destinationCity: 'Riyadh', weight: 0.5 })
      .catch(() => []);
    res.json({
      auth: health,
      pickupLocationCode: process.env.OTO_PICKUP_LOCATION_CODE ? '✓ set' : '✗ missing',
      sampleCities: cities.slice(0, 10).map((c) => c.name),
      deliveryOptionsCount: options.length,
      sampleOptions: options.slice(0, 5).map((o) => ({ name: o.deliveryOptionName, price: o.price })),
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

/** GET /api/oto/order-status?otoId=123 - OTO order status (and driver position if available). Syncs status to Supabase customer_orders when oto_id matches. */
otoRouter.get('/order-status', async (req, res) => {
  try {
    const otoId = req.query.otoId != null ? Number(req.query.otoId) : null;
    if (otoId == null || isNaN(otoId)) {
      return res.status(400).json({ error: 'Missing or invalid otoId' });
    }
    const status = await otoService.orderStatus(otoId);
    const mappedStatus = mapOtoStatusToOrderStatus(status?.status);
    if (supabaseAdmin && mappedStatus !== 'Preparing') {
      const { error } = await supabaseAdmin
        .from('customer_orders')
        .update({ status: mappedStatus, updated_at: new Date().toISOString() })
        .eq('oto_id', otoId);
      if (error) console.warn('[OTO] Supabase status sync failed:', error.message);
    }
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get order status' });
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
    console.log('[OTO] Delivery requested:', { orderId, otoId: result?.otoId, success: result?.success, deliveryOptionId: optId, carrier: optId == 6615 ? 'Mrsool' : '—' });
    res.json(result);
  } catch (err: any) {
    console.error('[OTO] request-delivery error:', err?.message);
    res.status(500).json({
      error: err?.message || 'Failed to request delivery',
    });
  }
});
