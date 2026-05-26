/**
 * Loyalty API client – balance, earn, redeem, rewards, config, history
 */
import { api } from './client';

export interface LoyaltyBalance {
  // Phase 1: stamps mode dropped; backend now returns 'points' or
  // 'cashback' only. The literal type is widened to include 'stamps'
  // until Phase 3 retires the mobile-UI screens that still pattern-
  // match on it, so the existing UI keeps compiling.
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
  // Legacy stamp-shaped fields — populated as zeros/empty arrays by
  // the server during the Phase 1 cut-over. Phase 3 will rewrite the
  // consumer UI around the points model and remove these.
  stampEnabled: boolean;
  stampTarget: number;
  stampRewardDescription: string;
  stamps: number;
  completedCards: number;
  stampMilestones: Array<{
    id: string;
    /** Phase 3 canonical points-redemption cost. */
    points_threshold?: number;
    /** Legacy alias mirroring points_threshold; populated for back-compat. */
    stamp_number: number;
    reward_name: string;
    reward_description?: string | null;
    reward_image_url?: string | null;
    foodics_product_ids: string[];
  }>;
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
  walletStampIconScale: number | null;
  businessType: string;
  /**
   * ISO timestamp of the last update to the merchant's loyalty_config row.
   * Used as a cache-bust signal for the local .pkpass cache: any save in
   * the dashboard bumps this, so the next Add-to-Wallet press fetches a
   * fresh pass instead of serving a stale cached one.
   */
  configUpdatedAt?: string | null;
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

/**
 * Phase 3 milestone redemption result.
 *
 * `success` and `newBalance` are the only fields the UI hard-depends on;
 * `redemptionId` is logged for support, `milestoneRewardName` flows into
 * the toast/confirmation, and `foodicsProductIds` is what the rewards
 * screen turns into 0-priced cart lines on success.
 *
 * `deduplicated` is set to true when an identical idempotencyKey was
 * replayed (the server returned the prior result instead of re-charging).
 * Clients use this to skip "added!" animations on retries.
 */
export type RedemptionResult = {
  success: boolean;
  newBalance: number;
  redemptionId: string;
  milestoneRewardName: string;
  foodicsProductIds: string[];
  deduplicated?: boolean;
};

/**
 * Phase 3 milestone catalog item — surfaced by GET /api/loyalty/stamp-milestones.
 * Mirrors the server-side row shape after the rename (points_threshold
 * replaces the legacy stamp_number).
 */
export type LoyaltyMilestone = {
  id: string;
  /** Phase 3 canonical field. Mirrors stamp_number for back-compat below. */
  points_threshold: number;
  /** Back-compat alias kept by the server so older clients keep compiling. */
  stamp_number: number;
  reward_name: string;
  reward_description: string | null;
  reward_image_url: string | null;
  foodics_product_ids: string[];
  is_active: boolean;
};

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

  /**
   * @deprecated use redeemMilestone — kept temporarily so any in-flight
   * builds still compile. The server route is now an alias of the new
   * /redeem-milestone path; both share the same handler.
   */
  redeemStampMilestone: (
    customerId: string,
    merchantId: string,
    milestoneId: string,
    orderId?: string,
  ) =>
    api.post<{ success: boolean; rewardName: string; stampsDeducted: number; newStamps: number }>(
      '/api/loyalty/redeem-stamp-milestone',
      { customerId, merchantId, milestoneId, via: 'app', orderId: orderId ?? null }
    ),

  /**
   * Phase 3 milestone redemption — points deduction model.
   *
   * The caller MUST generate a stable idempotencyKey per redemption
   * attempt (a client-side UUID is the standard pattern). If the user
   * double-taps the confirm button, the second call returns the same
   * RedemptionResult as the first one — no double-deduction — with
   * deduplicated=true so the UI can suppress duplicate animations.
   */
  redeemMilestone: (
    merchantId: string,
    customerId: string,
    milestoneId: string,
    idempotencyKey: string,
  ) =>
    api.post<RedemptionResult>('/api/loyalty/redeem-milestone', {
      customerId,
      merchantId,
      milestoneId,
      idempotencyKey,
    }),

  /**
   * Refund a milestone redemption when the customer removes the reward
   * from their cart before checkout. Idempotent — calling twice with the
   * same redemptionId returns the original refund result (no double-refund).
   * Server rejects with 409 if the originating order was already
   * checked out (points are spent at that point and can't be unspent).
   */
  unredeemMilestone: (
    merchantId: string,
    customerId: string,
    redemptionId: string,
  ) =>
    api.post<{ success: boolean; pointsRefunded?: number; newBalance?: number; deduplicated?: boolean }>(
      '/api/loyalty/unredeem-milestone',
      { customerId, merchantId, redemptionId },
    ),

  getMilestones: (merchantId: string) =>
    api.get<{ milestones: LoyaltyMilestone[] }>(
      `/api/loyalty/stamp-milestones?merchantId=${encodeURIComponent(merchantId)}`
    ),

  getHistory: (customerId: string, merchantId?: string) =>
    api.get<{ transactions: LoyaltyTransaction[] }>(
      `/api/loyalty/history?customerId=${encodeURIComponent(customerId)}${merchantId ? `&merchantId=${encodeURIComponent(merchantId)}` : ''}`
    ),
};
