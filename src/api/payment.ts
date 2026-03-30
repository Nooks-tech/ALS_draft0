/**
 * Payment API client - initiates payment via Tap or Moyasar
 */
import { api } from './client';

export interface InitiatePaymentPayload {
  amount: number;
  currency?: string;
  orderId?: string;
  merchantId: string;
  customer?: { name: string; email?: string; phone?: string };
  successUrl?: string;
}

export interface PaymentSession {
  id: string;
  url?: string;
  clientSecret?: string;
  status: string;
}

export interface StcPayInitiateResponse {
  paymentId: string;
  status: string;
}

export interface StcPayOtpResponse {
  paymentId: string;
  status: string;
}

export interface SavedCard {
  id: string;
  brand: string | null;
  last_four: string | null;
  name: string | null;
  expires_month: number | null;
  expires_year: number | null;
}

export const paymentApi = {
  initiate: (payload: InitiatePaymentPayload) =>
    api.post<PaymentSession>('/api/payment/initiate', payload),

  /** Initiate STC Pay — sends OTP to the customer's mobile */
  initiateStcPay: (orderId: string, merchantId: string, mobile: string, amount: number) =>
    api.post<StcPayInitiateResponse>('/api/payment/stcpay/initiate', {
      orderId,
      merchantId,
      mobile,
      amount,
    }),

  /** Verify STC Pay OTP to complete payment */
  verifyStcPayOtp: (paymentId: string, otp: string) =>
    api.post<StcPayOtpResponse>('/api/payment/stcpay/otp', {
      paymentId,
      otp,
    }),

  /** List saved cards for the current user + merchant */
  getSavedCards: (merchantId: string) =>
    api.get<SavedCard[]>(`/api/payment/saved-cards?merchantId=${encodeURIComponent(merchantId)}`),

  /** Delete a saved card */
  deleteSavedCard: (cardId: string) =>
    api.delete<{ deleted: boolean }>(`/api/payment/saved-cards/${encodeURIComponent(cardId)}`),

  /** Pay with a saved (tokenized) card */
  payWithSavedCard: (orderId: string, merchantId: string, savedCardId: string) =>
    api.post<PaymentSession>('/api/payment/token-pay', {
      orderId,
      merchantId,
      savedCardId,
    }),
};
