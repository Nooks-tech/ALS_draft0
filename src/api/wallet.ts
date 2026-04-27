/**
 * Customer wallet client. Mirrors the /api/wallet/* routes on the
 * Express server. Halalas → SAR conversion happens server-side; client
 * always works in SAR.
 */
import { api } from './client';

export type WalletEntry = {
  id: string;
  entry_type: 'topup' | 'spend' | 'refund' | 'adjustment';
  amount_sar: number; // signed: + for credit, - for debit
  balance_after_sar: number;
  order_id: string | null;
  payment_id: string | null;
  complaint_id: string | null;
  note: string | null;
  created_at: string;
};

export type WalletBalance = {
  balance_sar: number;
  total_topup_sar: number;
  total_spent_sar: number;
  total_refunded_sar: number;
  entries: WalletEntry[];
};

export type WalletTopupSession = {
  id: string;
  url?: string;
  status: string;
};

export const walletApi = {
  /** Current balance + last 50 ledger entries for (customer, merchant). */
  getBalance: (merchantId: string): Promise<WalletBalance> =>
    api.get<WalletBalance>(`/api/wallet/balance?merchantId=${encodeURIComponent(merchantId)}`),

  /**
   * Start a Moyasar payment whose proceeds flow into the wallet.
   * Returns the standard payment session shape ({ id, url, status }) so
   * the existing CreditCardPayment / Moyasar webview component can
   * render it without modification — only the metadata distinguishes
   * a wallet topup from a regular order payment.
   */
  topupInitiate: (params: {
    amount_sar: number;
    merchantId: string;
    customer?: { name: string; email?: string; phone?: string };
    successUrl?: string;
  }): Promise<WalletTopupSession> =>
    api.post<WalletTopupSession>('/api/wallet/topup-initiate', params),

  /**
   * Server-side Moyasar lookup + idempotent wallet credit. Call this
   * after Moyasar redirects back with status=paid. Idempotent — calling
   * twice for the same paymentId is a no-op (returns already_credited).
   */
  topupFinalize: (params: {
    paymentId: string;
    merchantId: string;
  }): Promise<{
    success: boolean;
    already_credited: boolean;
    credited_sar?: number;
    balance_sar: number;
  }> =>
    api.post('/api/wallet/topup-finalize', params),
};
