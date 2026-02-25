/**
 * Loyalty API client – points balance, earn, redeem, history
 */
import { api } from './client';

export interface LoyaltyBalance {
  points: number;
  lifetimePoints: number;
  pointsValue: number;
  pointsPerSar: number;
  pointValueSar: number;
}

export interface LoyaltyTransaction {
  id: string;
  type: 'earn' | 'redeem';
  points: number;
  description: string;
  created_at: string;
}

export const loyaltyApi = {
  getBalance: (customerId: string) =>
    api.get<LoyaltyBalance>(`/api/loyalty/balance?customerId=${encodeURIComponent(customerId)}`),

  earn: (customerId: string, orderId: string, orderSubtotal: number) =>
    api.post<{ success: boolean; pointsEarned: number; newBalance: number }>(
      '/api/loyalty/earn',
      { customerId, orderId, orderSubtotal }
    ),

  redeem: (customerId: string, points: number, orderId: string) =>
    api.post<{ success: boolean; pointsRedeemed: number; discountSar: number; newBalance: number }>(
      '/api/loyalty/redeem',
      { customerId, points, orderId }
    ),

  getHistory: (customerId: string) =>
    api.get<{ transactions: LoyaltyTransaction[] }>(
      `/api/loyalty/history?customerId=${encodeURIComponent(customerId)}`
    ),
};
