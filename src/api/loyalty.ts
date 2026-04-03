/**
 * Loyalty API client – balance, earn, redeem, rewards, config, history
 */
import { api } from './client';

export interface LoyaltyBalance {
  loyaltyType: 'cashback' | 'points' | 'stamps';
  memberCode: string;
  // Transition state
  transitioning?: boolean;
  oldSystemType?: 'cashback' | 'points' | 'stamps' | null;
  oldSystemBalance?: number;
  redeemType?: 'cashback' | 'points' | 'stamps' | null;
  // Points
  points: number;
  lifetimePoints: number;
  pointsValue: number;
  pointsPerSar: number;
  pointsPerOrder: number;
  pointValueSar: number;
  earnMode: 'per_sar' | 'per_order';
  expiryMonths: number | null;
  // Cashback
  cashbackBalance: number;
  cashbackPercent: number;
  maxCashbackPerOrderSar?: number | null;
  // Stamps
  stampEnabled: boolean;
  stampTarget: number;
  stampRewardDescription: string;
  stamps: number;
  completedCards: number;
  stampMilestones: Array<{ id: string; stamp_number: number; reward_name: string; foodics_product_ids: string[] }>;
  availableRedemptions: Array<{ id: string; milestone_id: string; stamp_number: number }>;
  // Wallet card
  walletCardBgColor: string | null;
  walletCardTextColor: string | null;
  walletCardLogoUrl: string | null;
  walletCardLogoScale: number | null;
  walletCardLabel: string | null;
  walletCardSecondaryLabel: string | null;
  walletCardBannerUrl: string | null;
  walletStampBoxColor: string | null;
  walletStampIconColor: string | null;
  walletStampIconUrl: string | null;
  businessType: string;
}

export interface LoyaltyTransaction {
  id: string;
  type: 'earn' | 'redeem' | 'expire';
  loyalty_type?: 'cashback' | 'points' | 'stamps' | null;
  points: number;
  amount_sar?: number | null;
  description: string;
  expired?: boolean;
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

  redeemCashback: (customerId: string, amountSar: number, orderId: string, merchantId: string) =>
    api.post<{ success: boolean; amountRedeemed: number; newBalance: number }>(
      '/api/loyalty/redeem-cashback',
      { customerId, amountSar, orderId, merchantId }
    ),

  getHistory: (customerId: string, merchantId?: string) =>
    api.get<{ transactions: LoyaltyTransaction[] }>(
      `/api/loyalty/history?customerId=${encodeURIComponent(customerId)}${merchantId ? `&merchantId=${encodeURIComponent(merchantId)}` : ''}`
    ),
};
