/**
 * Payment Service - Tap / Moyasar
 * Initiates payment sessions. Configure TAP_SECRET_KEY or MOYASAR_SECRET_KEY in .env
 */
import crypto from 'crypto';
import path from 'path';
import dotenv from 'dotenv';
import { getMerchantPaymentRuntimeConfig } from '../lib/merchantIntegrations';

/**
 * Moyasar's `given_id` field must be a valid UUID — it rejects our
 * `order-<timestamp>` ids with `given_id: must be a valid UUID`. Hash
 * the orderId into a deterministic v4-shaped UUID so retries with the
 * same orderId produce the same UUID (Moyasar treats matching given_ids
 * as idempotent and returns the original payment) but distinct orders
 * map to distinct UUIDs.
 */
function orderIdToUuid(orderId: string): string {
  const hex = crypto.createHash('sha256').update(String(orderId)).digest('hex');
  // Lay out as 8-4-4-4-12 with the version (4) and variant (8) nibbles
  // pinned so the result parses as a proper UUID v4.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    '8' + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

// Load .env from server/ (payment.ts is in server/services/, so ../.env = server/.env)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const TAP_SECRET_KEY = process.env.TAP_SECRET_KEY;
const MOYASAR_SECRET_KEY = process.env.MOYASAR_SECRET_KEY;
/** Public HTTPS base URL for payment redirects (e.g. https://api.als.delivery) - required for success_url */
const PAYMENT_REDIRECT_BASE = process.env.PAYMENT_REDIRECT_BASE_URL;
const NOOKS_COMMISSION_RATE = 0;

/* ── Moyasar fee rates (from signed offer) ── */
const FEE_RATES = {
  mada: 0.01,         // 1 %, capped at 200 SAR
  visa: 0.0275,       // 2.75 %
  master: 0.0275,
  mastercard: 0.0275,
  amex: 0.0275,
  stcpay: 0.015,      // 1.5 % (STC Pay wallet)
  international: 0.0375, // 3.75 %
} as const;
const MADA_CAP_SAR = 200;
const FRAUD_FEE_SAR = 1;
const REFUND_FEE_SAR = 1;

export { FEE_RATES, MADA_CAP_SAR, FRAUD_FEE_SAR, REFUND_FEE_SAR };

/**
 * Calculate estimated Moyasar fee for a payment.
 * All amounts in SAR.  Fees are pre-VAT (Moyasar adds 15 % VAT separately).
 */
export function calculateMoyasarFee(amountSAR: number, paymentMethod?: string): number {
  const method = (paymentMethod || '').toLowerCase();
  const rate = (FEE_RATES as Record<string, number>)[method] ?? FEE_RATES.visa;
  let fee = amountSAR * rate;
  if (method === 'mada') fee = Math.min(fee, MADA_CAP_SAR);
  return +(fee + FRAUD_FEE_SAR).toFixed(2);
}

export type CancelPaymentResult = {
  method: 'void' | 'refund' | 'failed' | 'not_required';
  fee: number;
  moyasarId?: string;
  error?: string;
  /** Moyasar payment status snapshot at the time of cancel attempt. */
  paymentStatus?: string;
};

export type VerifyPaymentResult =
  | { ok: true; status: 'paid' | 'captured'; amountHalals: number; moyasarId: string }
  | { ok: false; status: string; amountHalals: number; moyasarId: string; reason: string };

/**
 * Server-side verification that a Moyasar payment really cleared before
 * we persist an order. The customer app fires commitOrder on
 * PaymentStatus.paid (a client-side signal from the SDK) — without a
 * server-side recheck a tampered client could call /commit with any
 * paymentId, or a slow Moyasar webhook could leave the payment in
 * `initiated` while our DB row claims it's paid.
 *
 * Resolves invoice→payment IDs first (clients sometimes send the
 * invoice id), then fetches the payment and rejects unless status is
 * paid/captured. Optionally cross-checks the amount so a tampered
 * totalSar can't smuggle a smaller-amount paid payment as proof of a
 * larger order's payment.
 */
export async function verifyPaidPayment(
  paymentId: string,
  expectedAmountHalals: number,
  merchantId?: string | null,
): Promise<VerifyPaymentResult> {
  const scopedMerchantId = normalizeMerchantId(merchantId);
  const config = await getMerchantPaymentRuntimeConfig(scopedMerchantId);
  const secretKey = scopedMerchantId ? config.secretKey : (config.secretKey || MOYASAR_SECRET_KEY);
  if (!secretKey) {
    return { ok: false, status: 'unknown', amountHalals: 0, moyasarId: paymentId, reason: 'Moyasar secret key not configured' };
  }
  const authHeader = `Basic ${Buffer.from(secretKey + ':').toString('base64')}`;
  const realPaymentId = await resolvePaymentId(paymentId, authHeader, expectedAmountHalals);

  try {
    const res = await fetch(`https://api.moyasar.com/v1/payments/${realPaymentId}`, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) {
      return { ok: false, status: 'unknown', amountHalals: 0, moyasarId: realPaymentId, reason: `Moyasar HTTP ${res.status}` };
    }
    const payment = await res.json();
    const status = String(payment?.status ?? '').toLowerCase();
    const amountHalals = Number(payment?.amount ?? 0);
    if (status !== 'paid' && status !== 'captured') {
      return { ok: false, status, amountHalals, moyasarId: realPaymentId, reason: `payment status is "${status}"` };
    }
    // Amount mismatch defense: allow a 1-halala (0.01 SAR) drift for
    // rounding but reject anything larger. This blocks a tampered client
    // from passing a 5 SAR paid payment as proof of a 200 SAR order.
    if (Math.abs(amountHalals - expectedAmountHalals) > 1) {
      return {
        ok: false,
        status,
        amountHalals,
        moyasarId: realPaymentId,
        reason: `amount mismatch: paid ${amountHalals} halals, order expects ${expectedAmountHalals}`,
      };
    }
    return { ok: true, status: status as 'paid' | 'captured', amountHalals, moyasarId: realPaymentId };
  } catch (e: any) {
    return { ok: false, status: 'unknown', amountHalals: 0, moyasarId: realPaymentId, reason: e?.message || 'network error' };
  }
}

/**
 * Void-first cancel: tries void (free) then refund (1 SAR).
 * `amountHalals` is optional — omit for full refund/void.
 */
/**
 * Resolve the real Moyasar payment ID from whatever ID we have stored.
 * If the stored ID is an invoice, fetch the invoice to get the payment ID.
 */
async function resolvePaymentId(
  storedId: string,
  authHeader: string,
  expectedAmountHalals?: number,
): Promise<string> {
  // First try to fetch as a payment — if it works, it's already correct
  try {
    const res = await fetch(`https://api.moyasar.com/v1/payments/${storedId}`, {
      headers: { Authorization: authHeader },
    });
    if (res.ok) return storedId;
  } catch {}

  // If not a valid payment ID, try as an invoice and extract the right
  // payment. Moyasar invoices can carry multiple payments (one failed,
  // one succeeded; or retried attempts). Picking "the first paid" risks
  // refunding against a prior failed attempt.
  //
  // Disambiguation order:
  //   1) among paid/captured payments, match by expectedAmountHalals
  //   2) if no amount match, pick the most recently created
  //   3) last resort, fall through to storedId
  try {
    const res = await fetch(`https://api.moyasar.com/v1/invoices/${storedId}`, {
      headers: { Authorization: authHeader },
    });
    if (res.ok) {
      const invoice = await res.json();
      const payments: any[] = Array.isArray(invoice?.payments) ? invoice.payments : [];
      const succeeded = payments.filter((p) => p?.status === 'paid' || p?.status === 'captured');
      if (succeeded.length === 0) {
        console.warn('[Payment] Invoice', storedId, 'has no paid/captured payments');
      } else {
        const amountMatch =
          typeof expectedAmountHalals === 'number' && Number.isFinite(expectedAmountHalals)
            ? succeeded.find((p) => Number(p?.amount) === expectedAmountHalals)
            : null;
        if (amountMatch?.id) {
          console.log('[Payment] Resolved invoice', storedId, '-> payment (amount match)', amountMatch.id);
          return amountMatch.id;
        }
        const sorted = [...succeeded].sort((a, b) => {
          const ta = Date.parse(a?.created_at ?? '') || 0;
          const tb = Date.parse(b?.created_at ?? '') || 0;
          return tb - ta;
        });
        if (sorted[0]?.id) {
          console.log('[Payment] Resolved invoice', storedId, '-> payment (most recent)', sorted[0].id);
          return sorted[0].id;
        }
      }
    }
  } catch {}

  return storedId;
}

export async function cancelPayment(
  paymentId: string,
  amountHalals?: number,
  merchantId?: string | null,
): Promise<CancelPaymentResult> {
  const scopedMerchantId = normalizeMerchantId(merchantId);
  const config = await getMerchantPaymentRuntimeConfig(scopedMerchantId);
  const secretKey = scopedMerchantId ? config.secretKey : (config.secretKey || MOYASAR_SECRET_KEY);
  if (!secretKey) return { method: 'failed', fee: 0, error: 'Moyasar secret key not configured' };

  const authHeader = `Basic ${Buffer.from(secretKey + ':').toString('base64')}`;

  // Resolve invoice ID -> payment ID if needed. Pass the expected amount
  // so we pick the right payment when an invoice has multiple attempts.
  const realPaymentId = await resolvePaymentId(paymentId, authHeader, amountHalals);

  // Fetch the current Moyasar payment so we can short-circuit refund/void
  // calls for payments that never charged the card. Without this check:
  //   - `initiated` (customer never completed 3DS) → no money charged, but
  //     a /void call returns 4xx and the caller's fallback would
  //     incorrectly credit the wallet for funds that never moved.
  //   - `failed` → same shape as initiated.
  //   - `voided` / fully `refunded` → already returned to the customer;
  //     a second refund attempt would 4xx and risk a double-credit on
  //     the fallback path.
  // Returning `not_required` lets the caller skip BOTH the card refund
  // AND the wallet credit, since nothing is owed back.
  try {
    const statusRes = await fetch(`https://api.moyasar.com/v1/payments/${realPaymentId}`, {
      headers: { Authorization: authHeader },
    });
    if (statusRes.ok) {
      const payment = await statusRes.json();
      const status = String(payment?.status ?? '').toLowerCase();
      const refundedHalals = Number(payment?.refunded ?? 0);
      const amountHalalsCharged = Number(payment?.amount ?? 0);
      const fullyRefunded = status === 'refunded' && refundedHalals >= amountHalalsCharged && amountHalalsCharged > 0;
      if (status === 'initiated' || status === 'failed' || status === 'voided' || fullyRefunded) {
        console.log('[Payment] Cancel not required for', realPaymentId, '— status:', status);
        return { method: 'not_required', fee: 0, moyasarId: realPaymentId, paymentStatus: status };
      }
    } else {
      console.warn('[Payment] Status fetch non-ok:', statusRes.status, '— proceeding to attempt void/refund');
    }
  } catch (e: any) {
    console.warn('[Payment] Status fetch threw, proceeding to attempt void/refund:', e?.message);
  }

  // 1) Try void (free — works only if not yet settled).
  //    Skip void for partial refunds because void always reverses the FULL amount.
  if (amountHalals == null) {
    try {
      const voidRes = await fetch(`https://api.moyasar.com/v1/payments/${realPaymentId}/void`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      });
      if (voidRes.ok) {
        const data = await voidRes.json();
        console.log('[Payment] Void success for', realPaymentId);
        return { method: 'void', fee: 0, moyasarId: data?.id ?? realPaymentId };
      }
      const voidErr = await voidRes.json().catch(() => ({}));
      console.log('[Payment] Void not possible:', voidRes.status, voidErr?.message ?? '');
    } catch (e: any) {
      console.warn('[Payment] Void request error:', e?.message);
    }
  } else {
    console.log('[Payment] Partial amount specified, skipping void → going straight to refund');
  }

  // 2) Fallback: refund (1 SAR fee)
  try {
    const body: Record<string, unknown> = {};
    if (amountHalals != null) body.amount = amountHalals;
    const refundRes = await fetch(`https://api.moyasar.com/v1/payments/${realPaymentId}/refund`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const refundData = await refundRes.json();
    if (refundRes.ok) {
      console.log('[Payment] Refund success for', realPaymentId);
      return { method: 'refund', fee: REFUND_FEE_SAR, moyasarId: refundData?.id ?? realPaymentId };
    }
    console.error('[Payment] Refund failed:', refundRes.status, refundData);
    return { method: 'failed', fee: 0, error: refundData?.message || `Refund HTTP ${refundRes.status}` };
  } catch (e: any) {
    console.error('[Payment] Refund request error:', e?.message);
    return { method: 'failed', fee: 0, error: e?.message };
  }
}

export interface PaymentInitRequest {
  amount: number;
  currency?: string;
  orderId?: string;
  customer?: { name: string; email?: string; phone?: string };
  successUrl?: string;
  deliveryFee?: number;
  merchantId?: string | null;
  metadata?: Record<string, string>;
  saveCard?: boolean;
}

export interface PaymentSession {
  id: string;
  url?: string;
  clientSecret?: string;
  status: string;
  commission?: { rate: number; amount: number };
}

export function normalizeMerchantId(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function calculateCommission(totalAmount: number, deliveryFee: number = 0): { rate: number; amount: number } {
  const subtotal = Math.max(0, totalAmount - deliveryFee);
  return {
    rate: NOOKS_COMMISSION_RATE,
    amount: +(subtotal * NOOKS_COMMISSION_RATE).toFixed(2),
  };
}

export const paymentService = {
  async initiatePayment(req: PaymentInitRequest): Promise<PaymentSession> {
    const merchantId = normalizeMerchantId(req.merchantId);
    if (merchantId) {
      req.merchantId = merchantId;
      return this.initiateMoyasar(req);
    }
    if (TAP_SECRET_KEY) {
      return this.initiateTap(req);
    }
    if (MOYASAR_SECRET_KEY || req.merchantId) {
      return this.initiateMoyasar(req);
    }
    throw new Error('No payment provider configured. Set TAP_SECRET_KEY or MOYASAR_SECRET_KEY in .env');
  },

  async initiateTap(req: PaymentInitRequest): Promise<PaymentSession> {
    const res = await fetch('https://api.tap.company/v2/charges', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TAP_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: req.amount * 100,
        currency: req.currency || 'SAR',
        customer: req.customer
          ? {
              first_name: req.customer.name.split(' ')[0] || 'Customer',
              last_name: req.customer.name.split(' ').slice(1).join(' ') || '',
              email: req.customer.email || 'customer@example.com',
              phone: req.customer.phone ? { country_code: '966', number: req.customer.phone.replace(/\D/g, '') } : undefined,
            }
          : undefined,
        metadata: req.orderId ? { order_id: req.orderId } : undefined,
        redirect: { url: 'alsdraft0://payment/complete' },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.errors?.[0]?.description || 'Tap payment failed');
    return {
      id: data.id,
      url: data.transaction?.url,
      status: data.status || 'INITIATED',
    };
  },

  /**
   * Initiate an STC Pay payment via Moyasar.
   * STC Pay uses a two-step flow: initiate (sends OTP to mobile) then verify OTP.
   */
  async initiateStcPay(req: PaymentInitRequest & { mobile: string }): Promise<PaymentSession> {
    const merchantId = normalizeMerchantId(req.merchantId);
    if (!merchantId) {
      throw new Error('merchantId is required for STC Pay');
    }

    const runtimeConfig = await getMerchantPaymentRuntimeConfig(merchantId);
    if (!runtimeConfig.customerPaymentsEnabled) {
      throw new Error('Merchant checkout is not enabled for this merchant');
    }

    const secretKey = runtimeConfig.secretKey;
    if (!secretKey) {
      throw new Error('Moyasar secret key is not configured for this merchant');
    }

    const amountHalals = Math.round(Number(req.amount) * 100);
    const minAmount = 100; // Moyasar minimum 1 SAR
    const amount = Math.max(amountHalals, minAmount);

    const body: Record<string, unknown> = {
      amount: Math.floor(amount),
      currency: req.currency || 'SAR',
      description: req.orderId ? `Order ${req.orderId}` : 'ALS Order',
      source: {
        type: 'stcpay',
        mobile: req.mobile,
      },
      ...(req.orderId ? { given_id: orderIdToUuid(req.orderId) } : {}),
    };

    if (req.orderId || req.metadata) {
      body.metadata = {
        ...(req.orderId ? { order_id: String(req.orderId) } : {}),
        merchant_id: merchantId,
        ...(req.metadata || {}),
      };
    }

    const res = await fetch('https://api.moyasar.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(secretKey + ':').toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) {
      const errDetail = data?.errors ? JSON.stringify(data.errors) : data?.message;
      console.error('[Moyasar STC Pay] Payment initiation failed:', res.status, data);
      throw new Error(data?.message || (data?.errors ? `Validation: ${errDetail}` : 'STC Pay initiation failed'));
    }

    console.log('[Moyasar STC Pay] Payment created:', data.id, 'status:', data.status);
    const commission = calculateCommission(req.amount, req.deliveryFee);
    return {
      id: data.id,
      status: data.status || 'initiated',
      commission,
    };
  },

  async initiateMoyasar(req: PaymentInitRequest): Promise<PaymentSession> {
    const merchantId = normalizeMerchantId(req.merchantId);
    if (!merchantId) {
      throw new Error('merchantId is required for merchant checkout');
    }

    const runtimeConfig = await getMerchantPaymentRuntimeConfig(merchantId);
    if (!runtimeConfig.customerPaymentsEnabled) {
      throw new Error('Merchant checkout is not enabled for this merchant');
    }

    const secretKey = runtimeConfig.secretKey;
    if (!secretKey) {
      throw new Error('Moyasar secret key is not configured for this merchant');
    }
    const amountHalals = Math.round(Number(req.amount) * 100); // SAR to smallest unit (100 halals = 1 SAR)
    const minAmount = 100; // Moyasar minimum 1 SAR
    const amount = Math.max(amountHalals, minAmount);

    const body: Record<string, unknown> = {
      amount: Math.floor(amount), // Must be integer
      currency: req.currency || 'SAR',
      description: req.orderId ? `Order ${req.orderId}` : 'ALS Order',
      // Idempotency: derive given_id from orderId so retries don't create duplicate invoices
      ...(req.orderId ? { given_id: orderIdToUuid(req.orderId) } : {}),
    };
    if (req.orderId || req.metadata) {
      body.metadata = {
        ...(req.orderId ? { order_id: String(req.orderId) } : {}),
        merchant_id: merchantId,
        ...(req.metadata || {}),
      };
    }
    // Moyasar requires success_url to be https - custom schemes cause validation error
    const successUrl =
      req.successUrl?.startsWith('https://')
        ? req.successUrl
        : PAYMENT_REDIRECT_BASE
          ? `${PAYMENT_REDIRECT_BASE}/api/payment/redirect?to=${encodeURIComponent('alsdraft0://payment/success')}`
          : undefined;
    if (successUrl) body.success_url = successUrl;

    // When the customer opts to save their card, tell Moyasar to tokenize
    if (req.saveCard) {
      body.save_card = true;
    }

    const res = await fetch('https://api.moyasar.com/v1/invoices', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(secretKey + ':').toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) {
      const errDetail = data?.errors ? JSON.stringify(data.errors) : data?.message;
      console.error('[Moyasar] Invoice failed:', res.status, data);
      throw new Error(data?.message || (data?.errors ? `Validation: ${errDetail}` : 'Moyasar payment failed'));
    }

    const url = data.url;
    console.log('[Moyasar] Invoice created, url:', url ? 'yes' : 'no');
    const commission = calculateCommission(req.amount, req.deliveryFee);
    return {
      id: data.id,
      url: url || undefined,
      status: data.status || 'initiated',
      commission,
    };
  },

  /**
   * Pay using a previously-tokenized card (saved card).
   * Creates a Moyasar payment with source type "token".
   */
  async initiateMoyasarTokenPayment(req: PaymentInitRequest & { token: string }): Promise<PaymentSession> {
    const merchantId = normalizeMerchantId(req.merchantId);
    if (!merchantId) {
      throw new Error('merchantId is required for token payment');
    }

    const runtimeConfig = await getMerchantPaymentRuntimeConfig(merchantId);
    if (!runtimeConfig.customerPaymentsEnabled) {
      throw new Error('Merchant checkout is not enabled for this merchant');
    }

    const secretKey = runtimeConfig.secretKey;
    if (!secretKey) {
      throw new Error('Moyasar secret key is not configured for this merchant');
    }

    const amountHalals = Math.round(Number(req.amount) * 100);
    const minAmount = 100;
    const amount = Math.max(amountHalals, minAmount);

    // For token charges we ALWAYS use Moyasar's own return page as
    // the 3DS callback. Reasons:
    //   1) It's the URL Moyasar's official SDK uses, so it's
    //      guaranteed to be allowlisted on every issuer's side —
    //      sending a custom alsdraft0:// scheme made some banks
    //      reject 3DS with "invalid redirect".
    //   2) Our wallet/checkout code already watches for the
    //      sdk.moyasar.com hostname inside the WebView to detect
    //      verification completion. Anything else needs us to
    //      teach every WebView about a different host.
    // The req.successUrl override is left for callers that already
    // have a Moyasar-acceptable HTTPS endpoint configured.
    const successUrl =
      req.successUrl?.startsWith('https://')
        ? req.successUrl
        : 'https://sdk.moyasar.com/return';

    const body: Record<string, unknown> = {
      amount: Math.floor(amount),
      currency: req.currency || 'SAR',
      description: req.orderId ? `Order ${req.orderId}` : 'ALS Order',
      source: {
        type: 'token',
        token: req.token,
      },
      ...(req.orderId ? { given_id: orderIdToUuid(req.orderId) } : {}),
      callback_url: successUrl,
    };

    if (req.orderId || req.metadata) {
      body.metadata = {
        ...(req.orderId ? { order_id: String(req.orderId) } : {}),
        merchant_id: merchantId,
        ...(req.metadata || {}),
      };
    }

    const res = await fetch('https://api.moyasar.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(secretKey + ':').toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) {
      // Moyasar nests the actionable detail in `errors` (a per-field
      // dict). Surface those so the customer sees "card declined"
      // rather than the useless top-level "Data validation failed".
      console.error('[Moyasar Token] Payment failed:', res.status, JSON.stringify(data));
      const fieldErrors =
        data?.errors && typeof data.errors === 'object'
          ? Object.entries(data.errors)
              .map(([k, v]) => `${k}: ${Array.isArray(v) ? (v as string[]).join(', ') : v}`)
              .join('; ')
          : '';
      const message =
        fieldErrors ||
        data?.message ||
        `Token payment failed (HTTP ${res.status})`;
      throw new Error(message);
    }

    console.log('[Moyasar Token] Payment created:', data.id, 'status:', data.status);
    const commission = calculateCommission(req.amount, req.deliveryFee);
    return {
      id: data.id,
      url: data.source?.transaction_url || undefined,
      status: data.status || 'initiated',
      commission,
    };
  },
};
