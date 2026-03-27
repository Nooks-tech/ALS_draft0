/**
 * OTO Delivery API Service
 * Docs: https://help.tryoto.com - Authorization, Create Order, Create Shipment
 * OTO acts as a universal adapter for Uber, Careem, Barq, Aramex, etc.
 */

import { getMerchantDeliveryRuntimeConfig } from '../lib/merchantIntegrations';

const OTO_BASE = 'https://api.tryoto.com/rest/v2';
const OTO_REFRESH_TOKEN = process.env.OTO_REFRESH_TOKEN;
const OTO_PICKUP_LOCATION_CODE = process.env.OTO_PICKUP_LOCATION_CODE;
/** Prefer quick delivery (Careem, Barq, Marsool, etc.) - set deliveryOptionId from /api/oto/delivery-options */
const OTO_DELIVERY_OPTION_ID = process.env.OTO_DELIVERY_OPTION_ID
  ? parseInt(process.env.OTO_DELIVERY_OPTION_ID, 10)
  : undefined;

/** Only show/use these carriers (comma-separated). Empty = all carriers. Default: careem,mrsool,barq */
const OTO_PREFERRED_CARRIERS = (() => {
  const raw = process.env.OTO_PREFERRED_CARRIERS;
  if (raw === '') return [];
  const s = raw || 'careem,mrsool,barq';
  return s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
})();

function matchesPreferredCarrier(companyName: string): boolean {
  if (OTO_PREFERRED_CARRIERS.length === 0) return true;
  const n = (companyName || '').toLowerCase();
  return OTO_PREFERRED_CARRIERS.some((c) => n.includes(c));
}

const tokenCache = new Map<string, { accessToken: string; tokenExpiresAt: number }>();

async function getAccessToken(refreshTokenOverride?: string | null): Promise<string> {
  const refreshToken = refreshTokenOverride || OTO_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('OTO refresh token not configured');
  }
  const cached = tokenCache.get(refreshToken);
  if (cached && Date.now() < cached.tokenExpiresAt - 60000) {
    return cached.accessToken;
  }

  const res = await fetch(`${OTO_BASE}/refreshToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data?.message || `OTO auth failed: ${res.status}`);
  }

  const token = data?.access_token;
  if (!token) {
    throw new Error('OTO did not return access_token');
  }

  tokenCache.set(refreshToken, {
    accessToken: token,
    tokenExpiresAt: Date.now() + 60 * 60 * 1000,
  });
  return token;
}

async function otoRequest<T>(
  path: string,
  body: object,
  method: 'GET' | 'POST' = 'POST',
  refreshTokenOverride?: string | null
): Promise<T> {
  const token = await getAccessToken(refreshTokenOverride);
  const url = method === 'GET' && Object.keys(body).length > 0
    ? `${OTO_BASE}${path}?${new URLSearchParams(body as Record<string, string>).toString()}`
    : `${OTO_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data?.message || data?.errors?.[0] || `OTO API error: ${res.status}`);
  }

  return data as T;
}

export interface OTORequestDeliveryPayload {
  orderId: string;
  amount: number;
  merchantId?: string | null;
  /** Pickup location code for this branch - overrides OTO_PICKUP_LOCATION_CODE when set */
  pickupLocationCode?: string;
  /** deliveryOptionId from /api/oto/delivery-options - Mrsool when same-city, etc. */
  deliveryOptionId?: number;
  customer: {
    name: string;
    phone: string;
    email?: string;
  };
  deliveryAddress: {
    address: string;
    lat?: number;
    lng?: number;
    city?: string;
  };
  branch: {
    name: string;
    address?: string;
  };
  items: Array<{
    name: string;
    price: number;
    quantity: number;
  }>;
}

export interface OTOOrderResponse {
  success: boolean;
  otoId: number;
}

export interface OTOOrderStatusResponse {
  orderId?: string;
  status?: string;
  deliveryCompanyName?: string;
  trackingNumber?: string;
  estimatedDeliveryTime?: string;
  printAWBUrl?: string;
  driverLat?: number;
  driverLon?: number;
  [key: string]: unknown;
}

export const otoService = {
  async requestDelivery(payload: OTORequestDeliveryPayload): Promise<OTOOrderResponse> {
    const runtimeConfig = await getMerchantDeliveryRuntimeConfig(payload.merchantId);
    const refreshToken = runtimeConfig.refreshToken || OTO_REFRESH_TOKEN;
    if (!refreshToken) {
      throw new Error('OTO refresh token is not configured for this merchant');
    }
    if (!runtimeConfig.deliveryEnabled && payload.merchantId) {
      throw new Error('Delivery is disabled for this merchant');
    }

    const pickupCode = payload.pickupLocationCode || OTO_PICKUP_LOCATION_CODE;
    if (!pickupCode && payload.deliveryAddress) {
      console.warn('[OTO] No pickup location. Set OTO_PICKUP_LOCATION_CODE or pass pickupLocationCode per branch.');
    }

    const customer = payload.customer;
    const phone = (customer.phone || '').replace(/\D/g, '');
    const lat = payload.deliveryAddress.lat;
    const lon = payload.deliveryAddress.lng;

    const deliveryOptionId = payload.deliveryOptionId ?? OTO_DELIVERY_OPTION_ID;
    const otoOrder: Record<string, unknown> = {
      orderId: payload.orderId,
      createShipment: 'true',
      pickupLocationCode: pickupCode || undefined,
      payment_method: 'paid',
      amount: payload.amount,
      amount_due: 0,
      currency: 'SAR',
      shippingAmount: 0,
      subtotal: payload.amount,
      storeName: payload.branch.name,
      packageSize: 'small',
      packageCount: 1,
      packageWeight: 0.5,
      customer: {
        name: customer.name || 'Customer',
        email: customer.email || 'customer@nooks.sa',
        mobile: phone || '500000000',
        address: payload.deliveryAddress.address || '',
        city: payload.deliveryAddress.city || 'Riyadh',
        country: 'SA',
        postcode: '',
        ...(lat != null && lon != null && { lat: String(lat), lon: String(lon) }),
      },
      items: payload.items.map((item) => ({
        name: item.name,
        price: item.price,
        rowTotal: item.price * item.quantity,
        quantity: item.quantity,
        taxAmount: 0,
        sku: item.name.replace(/\s/g, '-').toLowerCase(),
      })),
    };
    if (deliveryOptionId != null) {
      otoOrder.deliveryOptionId = String(deliveryOptionId);
    }

    const result = await otoRequest<OTOOrderResponse>('/createOrder', otoOrder, 'POST', refreshToken);
    return result;
  },

  async getDeliveryOptions(params: {
    originCity: string;
    destinationCity: string;
    weight?: number;
    serviceType?: 'express' | 'sameDay' | 'fastDelivery' | 'coldDelivery' | 'heavyAndBulky' | 'electronicAndHeavy';
    originLat?: number;
    originLon?: number;
    destinationLat?: number;
    destinationLon?: number;
    length?: number;
    width?: number;
    height?: number;
  }): Promise<{ deliveryOptionId: number; deliveryCompanyName: string; deliveryOptionName: string; serviceType: string; price: number; avgDeliveryTime: string; source: 'oto' | 'own' }[]> {
    const baseBody: Record<string, any> = {
      originCity: params.originCity,
      destinationCity: params.destinationCity,
      weight: params.weight ?? 0.5,
    };
    if (params.serviceType) baseBody.serviceType = params.serviceType;
    if (params.originLat != null) baseBody.originLat = params.originLat;
    if (params.originLon != null) baseBody.originLon = params.originLon;
    if (params.destinationLat != null) baseBody.destinationLat = params.destinationLat;
    if (params.destinationLon != null) baseBody.destinationLon = params.destinationLon;
    if (params.length != null) baseBody.length = params.length;
    if (params.width != null) baseBody.width = params.width;
    if (params.height != null) baseBody.height = params.height;

    const mapOptions = (list: any[], source: 'oto' | 'own') =>
      (list ?? []).map((c: any) => ({
        deliveryOptionId: c.deliveryOptionId,
        deliveryCompanyName: c.deliveryCompanyName ?? '',
        deliveryOptionName: c.deliveryOptionName ?? '',
        serviceType: c.serviceType ?? '',
        price: c.price ?? 0,
        avgDeliveryTime: c.avgDeliveryTime ?? '',
        source,
      }));

    // 1) OTO's marketplace contracts (checkOTODeliveryFee) — Mrsool "Bullet" typically here
    const otoBody = { ...baseBody, originCountry: 'SA', destinationCountry: 'SA' };
    const otoPromise = otoRequest<{ deliveryCompany?: any[] }>('/checkOTODeliveryFee', otoBody)
      .then((d) => mapOptions(d?.deliveryCompany ?? [], 'oto'))
      .catch(() => [] as ReturnType<typeof mapOptions>);

    // 2) Your own DC contracts (checkDeliveryFee) — Careem, Barq when DC-activated
    const ownBody: Record<string, any> = {
      originCity: params.originCity,
      destinationCity: params.destinationCity,
      weight: params.weight ?? 0.5,
    };
    if (params.originLat != null) { ownBody.originLat = String(params.originLat); ownBody.originLon = String(params.originLon); }
    if (params.destinationLat != null) { ownBody.destinationLat = String(params.destinationLat); ownBody.destinationLon = String(params.destinationLon); }
    if (params.originLat != null || params.destinationLat != null) ownBody.deliveryType = 'bullet';
    const ownPromise = otoRequest<{ deliveryCompany?: any[] }>('/checkDeliveryFee', ownBody)
      .then((d) => mapOptions(d?.deliveryCompany ?? [], 'own'))
      .catch(() => [] as ReturnType<typeof mapOptions>);

    const [otoOpts, ownOpts] = await Promise.all([otoPromise, ownPromise]);

    // Merge: deduplicate by deliveryOptionId, prefer own contract pricing
    const seen = new Set<number>();
    const merged: typeof otoOpts = [];
    for (const o of [...ownOpts, ...otoOpts]) {
      if (!seen.has(o.deliveryOptionId)) {
        seen.add(o.deliveryOptionId);
        merged.push(o);
      }
    }

    const filtered = merged.filter((o) => matchesPreferredCarrier(o.deliveryCompanyName));

    if (filtered.length > 0) {
      console.log(`[OTO] ${filtered.length} delivery option(s): ${filtered.map((o) => `${o.deliveryCompanyName} (${o.source})`).join(', ')}`);
    }
    return filtered;
  },

  /** POST /dcList - list all delivery companies integrated with OTO */
  async dcList(): Promise<unknown> {
    const data = await otoRequest<unknown>('/dcList', {});
    return data;
  },

  /** GET /getDeliveryOptions - lists your activated DC contracts, optionally filtered by city or orderId */
  async getActivatedDeliveryOptions(city?: string, orderId?: string): Promise<unknown> {
    const params: Record<string, string> = {};
    if (city) params.city = city;
    if (orderId) params.orderId = orderId;
    const data = await otoRequest<unknown>('/getDeliveryOptions', params, 'GET');
    return data;
  },

  /** GET /getPickupLocationList - list pickup locations */
  async getPickupLocationList(status?: 'active' | 'inactive'): Promise<{
    warehouses: { id: number; code: string; name: string; address: string; city: string; contactPerson: string; contactPhone: string; contactEmail: string; lat?: number; lon?: number }[];
    branches: { id: number; code: string; name: string; address: string; city: string; contactPerson: string; contactPhone: string; contactEmail: string; lat?: number; lon?: number }[];
  }> {
    const params: Record<string, string> = { minDate: '2020-01-01', maxDate: '2030-12-31' };
    if (status) params.status = status;
    const data = await otoRequest<{ success?: boolean; warehouses?: any[]; branches?: any[] }>(
      '/getPickupLocationList',
      params,
      'GET'
    );
    return {
      warehouses: data?.warehouses ?? [],
      branches: data?.branches ?? [],
    };
  },

  /** POST /updatePickupLocation - update pickup location (e.g. set status: inactive) */
  async updatePickupLocation(payload: {
    code: string;
    name: string;
    mobile: string;
    address: string;
    city: string;
    country: string;
    contactName: string;
    contactEmail: string;
    status?: 'active' | 'inactive';
    lat?: number;
    lon?: number;
    type?: 'warehouse' | 'branch';
    [key: string]: any;
  }): Promise<{ success: boolean; message?: string }> {
    const data = await otoRequest<{ success: boolean; message?: string }>('/updatePickupLocation', payload);
    return data;
  },

  /** POST /createPickupLocation - create a new pickup location */
  async createPickupLocation(payload: {
    code: string;
    name: string;
    mobile: string;
    address: string;
    city: string;
    country: string;
    contactName: string;
    contactEmail: string;
    type?: 'warehouse' | 'branch';
    lat?: number;
    lon?: number;
    status?: 'active' | 'inactive';
    [key: string]: any;
  }): Promise<{ success: boolean; pickupLocationCode?: string; warhouseId?: string; message?: string }> {
    const data = await otoRequest<{ success: boolean; pickupLocationCode?: string; warhouseId?: string; message?: string }>(
      '/createPickupLocation',
      payload
    );
    return data;
  },

  /** POST /getCities - list valid city names for a country */
  async getCities(country = 'SA', perPage = 50): Promise<{ name: string }[]> {
    const data = await otoRequest<{ getCities?: { Cities?: { name: string }[] } }>('/getCities', {
      country,
      perPage,
      page: 1,
    });
    return data?.getCities?.Cities ?? [];
  },

  /**
   * Cancel an OTO delivery order.  Tries cancelOrder first (works if no shipment yet),
   * then cancelShipment (needs shipmentId, fails after "picked up").
   * Returns { cancelled, warning? } — never throws.
   */
  async cancelDelivery(orderId: string | number, shipmentId?: string, merchantId?: string | null): Promise<{ cancelled: boolean; warning?: string }> {
    const runtimeConfig = await getMerchantDeliveryRuntimeConfig(merchantId);
    const refreshToken = runtimeConfig.refreshToken || OTO_REFRESH_TOKEN;
    // Try cancelOrder first (lightweight, no shipment needed)
    try {
      await otoRequest<{ success?: boolean }>('/cancelOrder', { orderId: String(orderId) }, 'POST', refreshToken);
      console.log('[OTO] cancelOrder succeeded for', orderId);
      return { cancelled: true };
    } catch (e: any) {
      console.log('[OTO] cancelOrder failed:', e?.message);
    }

    // If shipmentId provided, try cancelShipment
    if (shipmentId) {
      try {
        await otoRequest<{ success?: boolean }>('/cancelShipment', {
          orderId: String(orderId),
          shipmentId,
        }, 'POST', refreshToken);
        console.log('[OTO] cancelShipment succeeded for', orderId, shipmentId);
        return { cancelled: true };
      } catch (e: any) {
        const msg = e?.message || '';
        console.warn('[OTO] cancelShipment failed:', msg);
        return { cancelled: false, warning: `OTO shipment cancel failed: ${msg}` };
      }
    }

    // No shipmentId — try to fetch it from orderDetails
    try {
      const details = await this.orderStatus(orderId, merchantId);
      const trackingNumber = details.trackingNumber;
      if (trackingNumber) {
        try {
          await otoRequest<{ success?: boolean }>('/cancelShipment', {
            orderId: String(orderId),
            shipmentId: trackingNumber,
          }, 'POST', refreshToken);
          console.log('[OTO] cancelShipment (auto-fetched) succeeded for', orderId);
          return { cancelled: true };
        } catch (e: any) {
          return { cancelled: false, warning: `OTO cancel failed: ${e?.message}` };
        }
      }
    } catch { /* ignore */ }

    return { cancelled: false, warning: 'Could not cancel OTO order (may already be picked up)' };
  },

  async healthCheck(merchantId?: string | null): Promise<boolean> {
    try {
      const runtimeConfig = await getMerchantDeliveryRuntimeConfig(merchantId);
      await getAccessToken(runtimeConfig.refreshToken || OTO_REFRESH_TOKEN);
      const cities = await this.getCities('SA', 1);
      return cities.length > 0;
    } catch {
      return false;
    }
  },

  /**
   * Get order details from OTO including status and shipment tracking.
   * Uses GET /orderDetails?orderId=X (official OTO v2 endpoint).
   * orderId is the OTO order id (numeric otoId from createOrder, or your orderId string).
   */
  async orderStatus(orderId: number | string, merchantId?: string | null): Promise<OTOOrderStatusResponse> {
    const runtimeConfig = await getMerchantDeliveryRuntimeConfig(merchantId);
    const refreshToken = runtimeConfig.refreshToken || OTO_REFRESH_TOKEN;
    const data = await otoRequest<Record<string, unknown>>('/orderDetails', {
      orderId: String(orderId),
    }, 'GET', refreshToken);

    const shipments = Array.isArray(data?.shipments) ? data.shipments as Record<string, unknown>[] : [];
    const latestShipment = shipments[0];
    const tracking = latestShipment?.tracking as Record<string, unknown> | undefined;

    return {
      orderId: String(data?.orderId ?? orderId),
      status: String(data?.status ?? latestShipment?.status ?? ''),
      deliveryCompanyName: String(latestShipment?.deliveryCompanyName ?? ''),
      trackingNumber: String(latestShipment?.trackingNumber ?? ''),
      estimatedDeliveryTime: String(latestShipment?.estimatedDeliveryTime ?? ''),
      printAWBUrl: typeof latestShipment?.printAWBUrl === 'string' ? latestShipment.printAWBUrl : undefined,
      driverLat: typeof tracking?.lat === 'number' ? tracking.lat : (typeof tracking?.lat === 'string' ? parseFloat(tracking.lat) : undefined),
      driverLon: typeof tracking?.lon === 'number' ? tracking.lon : (typeof tracking?.lon === 'string' ? parseFloat(tracking.lon) : undefined),
    };
  },

  /** POST /webhook – register a webhook URL with OTO */
  async registerWebhook(url: string, webhookType = 'orderStatus', merchantId?: string | null): Promise<{ success: boolean; message?: string }> {
    const runtimeConfig = await getMerchantDeliveryRuntimeConfig(merchantId);
    const refreshToken = runtimeConfig.refreshToken || OTO_REFRESH_TOKEN;
    const data = await otoRequest<{ success?: boolean; message?: string }>('/webhook', {
      method: 'post',
      url,
      webhookType,
    }, 'POST', refreshToken);
    return { success: data?.success !== false, message: data?.message };
  },
};
