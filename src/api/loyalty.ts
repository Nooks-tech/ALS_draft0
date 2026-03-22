/**
 * Loyalty API client – balance, earn, redeem, rewards, config, history
 */
import { api } from './client';

export interface LoyaltyBalance {
  points: number;
  lifetimePoints: number;
  pointsValue: number;
  pointsPerSar: number;
  pointsPerOrder: number;
  pointValueSar: number;
  earnMode: 'per_sar' | 'per_order';
  expiryMonths: number | null;
  stampEnabled: boolean;
  stampTarget: number;
  stampRewardDescription: string;
  stamps: number;
  completedCards: number;
  walletCardBgColor: string | null;
  walletCardTextColor: string | null;
  walletCardLogoUrl: string | null;
  /** 20–200 when set in dashboard; null = follow app in-app logo scale */
  walletCardLogoScale: number | null;
  walletCardLabel: string | null;
  walletCardSecondaryLabel: string | null;
}

export interface LoyaltyTransaction {
  id: string;
  type: 'earn' | 'redeem';
  points: number;
  description: string;
  created_at: string;
}

export interface LoyaltyReward {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  points_cost: number;
  is_active: boolean;
}

export interface LoyaltyConfig {
  earn_mode: 'per_sar' | 'per_order';
  points_per_sar: number;
  points_per_order: number;
  point_value_sar: number;
  expiry_months: number | null;
  stamp_enabled: boolean;
  stamp_target: number;
  stamp_reward_description: string;
  wallet_card_logo_scale?: number | null;
}

export const loyaltyApi = {
  getBalance: (customerId: string, merchantId?: string) =>
    api.get<LoyaltyBalance>(
      `/api/loyalty/balance?customerId=${encodeURIComponent(customerId)}${merchantId ? `&merchantId=${encodeURIComponent(merchantId)}` : ''}`
    ),

  getConfig: (merchantId: string) =>
    api.get<LoyaltyConfig>(`/api/loyalty/config?merchantId=${encodeURIComponent(merchantId)}`),

  getRewards: (merchantId: string) =>
    api.get<{ rewards: LoyaltyReward[] }>(`/api/loyalty/rewards?merchantId=${encodeURIComponent(merchantId)}`),

  redeemReward: (customerId: string, rewardId: string, merchantId: string) =>
    api.post<{ success: boolean; reward: string; pointsSpent: number; newBalance: number }>(
      '/api/loyalty/redeem-reward',
      { customerId, rewardId, merchantId }
    ),

  earn: (customerId: string, orderId: string, orderSubtotal: number, merchantId?: string) =>
    api.post<{ success: boolean; pointsEarned: number; newBalance: number }>(
      '/api/loyalty/earn',
      { customerId, orderId, orderSubtotal, merchantId }
    ),

  redeem: (customerId: string, points: number, orderId: string, merchantId?: string) =>
    api.post<{ success: boolean; pointsRedeemed: number; discountSar: number; newBalance: number }>(
      '/api/loyalty/redeem',
      { customerId, points, orderId, merchantId }
    ),

  getHistory: (customerId: string, merchantId?: string) =>
    api.get<{ transactions: LoyaltyTransaction[] }>(
      `/api/loyalty/history?customerId=${encodeURIComponent(customerId)}${merchantId ? `&merchantId=${encodeURIComponent(merchantId)}` : ''}`
    ),
};
