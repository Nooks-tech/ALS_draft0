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

// Kept as a stub so checkout.tsx still type-checks; the server route was
// removed and any call to these endpoints now 404s. Full UI removal from
// checkout.tsx is a deferred follow-up — for now the STC Pay button just
// errors out on tap, which is fine because no merchant currently uses it.
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

  /** STC Pay endpoints (server side removed). The methods below remain
   *  only so checkout.tsx's existing UI compiles; calling them now hits
   *  a 404 from the server (route was deleted). Full UI removal in
   *  checkout.tsx is a follow-up. */
  initiateStcPay: (orderId: string, merchantId: string, mobile: string, amount: number) =>
    api.post<StcPayInitiateResponse>('/api/payment/stcpay/initiate', {
      orderId,
      merchantId,
      mobile,
      amount,
    }),
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

  /**
   * Attach a Moyasar token to the customer (after the client has called
   * Moyasar's /v1/tokens directly with save_only=true). The server
   * re-fetches the token using the secret key to read the canonical
   * brand/last_four metadata, so the client never has to send those
   * (and can't forge them).
   */
  attachSavedCard: (params: { merchantId: string; token: string }) =>
    api.post<SavedCard & { already_saved: boolean }>('/api/payment/saved-cards/attach', params),

  /** Pay with a saved (tokenized) card */
  payWithSavedCard: (orderId: string, merchantId: string, savedCardId: string) =>
    api.post<PaymentSession>('/api/payment/token-pay', {
      orderId,
      merchantId,
      savedCardId,
    }),
};
