/**
 * Payment API client - initiates payment via Tap or Moyasar
 */
import { api } from './client';

export interface InitiatePaymentPayload {
  amount: number;
  currency?: string;
  orderId?: string;
  customer?: { name: string; email?: string; phone?: string };
  successUrl?: string;
}

export interface PaymentSession {
  id: string;
  url?: string;
  clientSecret?: string;
  status: string;
}

export const paymentApi = {
  initiate: (payload: InitiatePaymentPayload) =>
    api.post<PaymentSession>('/api/payment/initiate', payload),
};
