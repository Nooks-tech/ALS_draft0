/**
 * Payment Service - Tap / Moyasar
 * Initiates payment sessions. Configure TAP_SECRET_KEY or MOYASAR_SECRET_KEY in .env
 */
import path from 'path';
import dotenv from 'dotenv';

// Load .env from server/ (payment.ts is in server/services/, so ../.env = server/.env)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const TAP_SECRET_KEY = process.env.TAP_SECRET_KEY;
const MOYASAR_SECRET_KEY = process.env.MOYASAR_SECRET_KEY;
/** Public HTTPS base URL for payment redirects (e.g. https://api.als.delivery) - required for success_url */
const PAYMENT_REDIRECT_BASE = process.env.PAYMENT_REDIRECT_BASE_URL;
const NOOKS_COMMISSION_RATE = parseFloat(process.env.NOOKS_COMMISSION_RATE || '0.01');

export interface PaymentInitRequest {
  amount: number;
  currency?: string;
  orderId?: string;
  customer?: { name: string; email?: string; phone?: string };
  successUrl?: string;
  deliveryFee?: number;
}

export interface PaymentSession {
  id: string;
  url?: string;
  clientSecret?: string;
  status: string;
  commission?: { rate: number; amount: number };
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
    if (TAP_SECRET_KEY) {
      return this.initiateTap(req);
    }
    if (MOYASAR_SECRET_KEY) {
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

  async initiateMoyasar(req: PaymentInitRequest): Promise<PaymentSession> {
    const amountHalals = Math.round(Number(req.amount) * 100); // SAR to smallest unit (100 halals = 1 SAR)
    const minAmount = 100; // Moyasar minimum 1 SAR
    const amount = Math.max(amountHalals, minAmount);

    const body: Record<string, unknown> = {
      amount: Math.floor(amount), // Must be integer
      currency: req.currency || 'SAR',
      description: req.orderId ? `Order ${req.orderId}` : 'ALS Order',
    };
    if (req.orderId) body.metadata = { order_id: String(req.orderId) };
    // Moyasar requires success_url to be https - custom schemes cause validation error
    const successUrl =
      req.successUrl?.startsWith('https://')
        ? req.successUrl
        : PAYMENT_REDIRECT_BASE
          ? `${PAYMENT_REDIRECT_BASE}/api/payment/redirect?to=${encodeURIComponent('alsdraft0://payment/success')}`
          : undefined;
    if (successUrl) body.success_url = successUrl;

    const res = await fetch('https://api.moyasar.com/v1/invoices', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(MOYASAR_SECRET_KEY + ':').toString('base64')}`,
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
};
