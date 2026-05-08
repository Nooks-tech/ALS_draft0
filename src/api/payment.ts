/**
 * Payment API client - saved-card / tokenization endpoints (Moyasar)
 */
import { api } from './client';

export interface PaymentSession {
  id: string;
  url?: string;
  clientSecret?: string;
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
