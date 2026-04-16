/**
 * OTO Delivery API Service
 * Docs: https://help.tryoto.com - Authorization, Create Order, Create Shipment
 * OTO acts as a universal adapter for Uber, Careem, Barq, Aramex, etc.
 */

import { getMerchantDeliveryRuntimeConfig } from '../lib/merchantIntegrations';

const OTO_BASE_PRODUCTION = 'https://api.tryoto.com/rest/v2';
const OTO_BASE_SANDBOX = 'https://staging-api.tryoto.com/rest/v2';
const OTO_REFRESH_TOKEN = process.env.OTO_REFRESH_TOKEN;

function getOtoBase(environment?: 'sandbox' | 'production'): string {
  return environment === 'sandbox' ? OTO_BASE_SANDBOX : OTO_BASE_PRODUCTION;
}

/** Default bullet delivery carriers (comma-separated). Used when merchant has no preference set. */
const DEFAULT_PREFERRED_CARRIERS = ['careem', 'mrsool', 'dal', 'barq', 'logi'];

/**
 * Canonical carrier names. Maps any OTO-returned company name variant to a single
 * canonical key, so the preferred-carrier filter is exact-match instead of substring.
 *
 * Add new entries here when OTO returns a new variant — never use substring matching
 * because that lets `"careem-discount"` slip through when the merchant only enabled `"careem"`.
 */
const CARRIER_ALIASES: Record<string, string> = {
  // Careem
  careem: 'careem',
  careemexpress: 'careem',
  careemnow: 'careem',
  careemfood: 'careem',
  // Mrsool
  mrsool: 'mrsool',
  marsool: 'mrsool',
  msool: 'mrsool',
  // DAL
  dal: 'dal',
  daldelivery: 'dal',
  // Barq
  barq: 'barq',
  barqfleet: 'barq',
  // LogiPoint / Logi
  logi: 'logi',
  logipoint: 'logi',
  // SMSA / Aramex / Aymakan are NOT bullet carriers — listed for completeness so they can be
  // explicitly allowed by merchants who want intercity contracts.
  smsa: 'smsa',
  aramex: 'aramex',
  aymakan: 'aymakan',
};

function canonicalCarrier(name: string): string | null {
  const normalized = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return null;
  // Exact alias hit first
  if (CARRIER_ALIASES[normalized]) return CARRIER_ALIASES[normalized];
  // Then try the longest known alias prefix (handles "careemxxx" → careem)
  const aliasKeys = Object.keys(CARRIER_ALIASES).sort((a, b) => b.length - a.length);
  for (const key of aliasKeys) {
    if (normalized.startsWith(key) || normalized.endsWith(key)) {
      return CARRIER_ALIASES[key];
    }
  }
  return normalized;
}

/** Parse a comma-separated carrier string into a normalized canonical-name set. Empty string = all carriers. */
function parsePreferredCarriers(raw: string | null | undefined): Set<string> {
  if (raw === '') return new Set(); // explicit empty = allow all
  const s = raw || DEFAULT_PREFERRED_CARRIERS.join(',');
  const out = new Set<string>();
  for (const piece of s.split(',')) {
    const canonical = canonicalCarrier(piece.trim());
    if (canonical) out.add(canonical);
  }
  return out;
}

function matchesPreferredCarrier(companyName: string, carriers: Set<string>): boolean {
  if (carriers.size === 0) return true;
  const canonical = canonicalCarrier(companyName);
  if (!canonical) return false;
  return carriers.has(canonical);
}

const tokenCache = new Map<string, { accessToken: string; tokenExpiresAt: number }>();

export function normalizeMerchantId(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function resolveScopedRefreshToken(
  merchantId: string | null,
  refreshToken: string | null,
): string | null {
  if (merchantId) return refreshToken;
  return refreshToken || OTO_REFRESH_TOKEN || null;
}

async function getAccessToken(refreshTokenOverride?: string | null, environment?: 'sandbox' | 'production'): Promise<string> {
  const refreshToken = refreshTokenOverride || OTO_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('OTO refresh token not configured');
  }
  const cached = tokenCache.get(refreshToken);
  if (cached && Date.now() < cached.tokenExpiresAt - 60000) {
    return cached.accessToken;
  }

  const base = getOtoBase(environment);
  const res = await fetch(`${base}/refreshToken`, {
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

const RETRY_STATUS_CODES = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

async function otoRequest<T>(
  path: string,
  body: object,
  method: 'GET' | 'POST' = 'POST',
  refreshTokenOverride?: string | null,
  environment?: 'sandbox' | 'production'
): Promise<T> {
  const token = await getAccessToken(refreshTokenOverride, environment);
  const base = getOtoBase(environment);
  const url = method === 'GET' && Object.keys(body).length > 0
    ? `${base}${path}?${new URLSearchParams(body as Record<string, string>).toString()}`
    : `${base}${path}`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
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

    if (res.ok) {
      return data as T;
    }

    // Log the full response body once per failure so we don't have to guess
    // what OTO rejected. Bodies are small JSON, usually a few fields.
    try {
      console.warn(`[OTO] ${method} ${path} → ${res.status}`, JSON.stringify(data).slice(0, 500));
    } catch { /* ignore logging errors */ }

    const otoMessage =
      (typeof data?.message === 'string' && data.message) ||
      (Array.isArray(data?.errors) && typeof data.errors[0] === 'string' && data.errors[0]) ||
      (typeof data?.error === 'string' && data.error) ||
      (data && typeof data === 'object' ? JSON.stringify(data).slice(0, 200) : '');
    lastError = new Error(otoMessage ? `OTO API error: ${res.status} ${otoMessage}` : `OTO API error: ${res.status}`);

    // Only retry on transient server errors; don't retry client errors like 400, 401, 404
    if (!RETRY_STATUS_CODES.has(res.status)) {
      throw lastError;
    }
    console.warn(`[OTO] Request to ${path} returned ${res.status}, retry ${attempt + 1}/${MAX_RETRIES}`);
  }

  throw lastError!;
}

export interface OTORequestDeliveryPayload {
  orderId: string;
  amount: number;
  merchantId: string;
  /** Pickup location code for this branch (oto_warehouse_id from nooksweb) */
  pickupLocationCode?: string;
  /** deliveryOptionId from dynamic rate shopping (/api/oto/delivery-options) */
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
    const merchantId = normalizeMerchantId(payload.merchantId);
    if (!merchantId) {
      throw new Error('merchantId is required for delivery dispatch');
    }

    const runtimeConfig = await getMerchantDeliveryRuntimeConfig(merchantId);
    const refreshToken = resolveScopedRefreshToken(merchantId, runtimeConfig.refreshToken);
    if (!refreshToken) {
      throw new Error('OTO refresh token is not configured for this merchant');
    }
    if (!runtimeConfig.deliveryEnabled) {
      throw new Error('Delivery is disabled for this merchant');
    }

    const pickupCode = payload.pickupLocationCode;
    if (!pickupCode) {
      console.warn('[OTO] No pickup location code for this branch. Set oto_warehouse_id on the branch in nooksweb.');
    }

    const customer = payload.customer;
    const phone = (customer.phone || '').replace(/\D/g, '');
    if (!phone) {
      throw new Error(`OTO dispatch refused: customer phone is required (order ${payload.orderId})`);
    }
    if (!payload.deliveryAddress?.city) {
      throw new Error(`OTO dispatch refused: delivery city is required (order ${payload.orderId})`);
    }
    if (!payload.deliveryAddress?.address) {
      throw new Error(`OTO dispatch refused: delivery address is required (order ${payload.orderId})`);
    }
    const lat = payload.deliveryAddress.lat;
    const lon = payload.deliveryAddress.lng;

    const deliveryOptionId = payload.deliveryOptionId;
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
        mobile: phone,
        address: payload.deliveryAddress.address,
        city: payload.deliveryAddress.city,
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

    const result = await otoRequest<OTOOrderResponse>('/createOrder', otoOrder, 'POST', refreshToken, runtimeConfig.environment);
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
    /** Merchant ID for per-merchant OTO token and carrier preferences */
    merchantId?: string;
  }): Promise<{ deliveryOptionId: number; deliveryCompanyName: string; deliveryOptionName: string; serviceType: string; price: number; avgDeliveryTime: string; source: 'oto' | 'own' }[]> {
    // Resolve per-merchant OTO token and carrier preferences
    const scopedMerchantId = normalizeMerchantId(params.merchantId);
    const runtimeConfig = await getMerchantDeliveryRuntimeConfig(scopedMerchantId);
    const refreshToken = resolveScopedRefreshToken(scopedMerchantId, runtimeConfig.refreshToken);
    const carriers = parsePreferredCarriers(runtimeConfig.preferredCarriers);

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

    // 1) OTO's marketplace contracts (checkOTODeliveryFee) — bullet delivery only
    const otoBody = { ...baseBody, originCountry: 'SA', destinationCountry: 'SA', deliveryType: 'bullet' };
    const env = runtimeConfig.environment;
    const otoPromise = otoRequest<{ deliveryCompany?: any[] }>('/checkOTODeliveryFee', otoBody, 'POST', refreshToken, env)
      .then((d) => mapOptions(d?.deliveryCompany ?? [], 'oto'))
      .catch(() => [] as ReturnType<typeof mapOptions>);

    // 2) Merchant's own DC contracts — bullet delivery only (Careem, Mrsool, DAL)
    const ownBody: Record<string, any> = {
      originCity: params.originCity,
      destinationCity: params.destinationCity,
      weight: params.weight ?? 0.5,
      deliveryType: 'bullet',
    };
    if (params.originLat != null) { ownBody.originLat = String(params.originLat); ownBody.originLon = String(params.originLon); }
    if (params.destinationLat != null) { ownBody.destinationLat = String(params.destinationLat); ownBody.destinationLon = String(params.destinationLon); }
    const ownPromise = otoRequest<{ deliveryCompany?: any[] }>('/checkDeliveryFee', ownBody, 'POST', refreshToken, env)
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

    const filtered = merged.filter((o) => matchesPreferredCarrier(o.deliveryCompanyName, carriers));

    if (filtered.length > 0) {
      console.log(`[OTO] ${filtered.length} delivery option(s) for merchant ${scopedMerchantId ?? 'platform'}: ${filtered.map((o) => `${o.deliveryCompanyName} (${o.source})`).join(', ')}`);
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

  /**
   * POST /createPickupLocation — create a new pickup location on OTO.
   *
   * Scoped to the merchant's own OTO refresh token when merchantId is supplied,
   * so auto-setup during Foodics sync hits the correct OTO account. If no
   * merchantId is supplied, falls back to the platform OTO_REFRESH_TOKEN env
   * (useful for internal tooling only).
   */
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
    merchantId?: string | null;
    [key: string]: any;
  }): Promise<{ success: boolean; pickupLocationCode?: string; warhouseId?: string; message?: string }> {
    const scopedMerchantId = normalizeMerchantId(payload.merchantId ?? null);
    const runtimeConfig = await getMerchantDeliveryRuntimeConfig(scopedMerchantId);
    const refreshToken = resolveScopedRefreshToken(scopedMerchantId, runtimeConfig.refreshToken);
    if (!refreshToken) {
      throw new Error('OTO refresh token is not configured for this merchant');
    }
    // Don't forward the scoping field to OTO — it's internal.
    const { merchantId: _merchantId, ...otoPayload } = payload;
    const data = await otoRequest<{ success: boolean; pickupLocationCode?: string; warhouseId?: string; message?: string }>(
      '/createPickupLocation',
      otoPayload,
      'POST',
      refreshToken,
      runtimeConfig.environment,
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
    const scopedMerchantId = normalizeMerchantId(merchantId);
    const runtimeConfig = await getMerchantDeliveryRuntimeConfig(scopedMerchantId);
    const refreshToken = resolveScopedRefreshToken(scopedMerchantId, runtimeConfig.refreshToken);
    if (!refreshToken) {
      return { cancelled: false, warning: 'OTO refresh token not configured for this merchant' };
    }
    const env = runtimeConfig.environment;
    // Try cancelOrder first (lightweight, no shipment needed)
    try {
      await otoRequest<{ success?: boolean }>('/cancelOrder', { orderId: String(orderId) }, 'POST', refreshToken, env);
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
        }, 'POST', refreshToken, env);
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
          }, 'POST', refreshToken, env);
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
      const scopedMerchantId = normalizeMerchantId(merchantId);
      const runtimeConfig = await getMerchantDeliveryRuntimeConfig(scopedMerchantId);
      const refreshToken = resolveScopedRefreshToken(scopedMerchantId, runtimeConfig.refreshToken);
      if (!refreshToken) return false;
      await getAccessToken(refreshToken, runtimeConfig.environment);
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
    const scopedMerchantId = normalizeMerchantId(merchantId);
    const runtimeConfig = await getMerchantDeliveryRuntimeConfig(scopedMerchantId);
    const refreshToken = resolveScopedRefreshToken(scopedMerchantId, runtimeConfig.refreshToken);
    if (!refreshToken) {
      throw new Error('OTO refresh token is not configured for this merchant');
    }
    const data = await otoRequest<Record<string, unknown>>('/orderDetails', {
      orderId: String(orderId),
    }, 'GET', refreshToken, runtimeConfig.environment);

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
    const scopedMerchantId = normalizeMerchantId(merchantId);
    const runtimeConfig = await getMerchantDeliveryRuntimeConfig(scopedMerchantId);
    const refreshToken = resolveScopedRefreshToken(scopedMerchantId, runtimeConfig.refreshToken);
    if (!refreshToken) {
      return { success: false, message: 'OTO refresh token is not configured for this merchant' };
    }
    const data = await otoRequest<{ success?: boolean; message?: string }>('/webhook', {
      method: 'post',
      url,
      webhookType,
    }, 'POST', refreshToken, runtimeConfig.environment);
    return { success: data?.success !== false, message: data?.message };
  },
};
