/**
 * Loyalty routes – merchant-config-driven points, stamps, rewards, and wallet pass
 */
import { createClient } from '@supabase/supabase-js';
import { Router, type Request, type Response } from 'express';
import { notifyPassUpdate } from './walletPass';
import { ensureLoyaltyMemberProfile, findLoyaltyMemberByLookup } from '../services/loyaltyMembers';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';
import { requireDiagnosticAccess, requireNooksInternalRequest } from '../utils/nooksInternal';
import { sendLocalizedPushScoped } from '../utils/push';

export const loyaltyRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const DEFAULT_CONFIG = {
  loyalty_type: null as 'cashback' | 'stamps' | null,  // 'points' removed — only cashback + stamps supported
  earn_mode: 'per_sar' as const,
  points_per_sar: 0.1,
  points_per_order: 10,
  point_value_sar: 0.1,
  cashback_percent: 5,
  expiry_months: null as number | null,
  stamp_enabled: false,
  stamp_target: 8,
  stamp_reward_description: 'Free item',
  wallet_card_logo_scale: null as number | null,
  wallet_stamp_icon_scale: null as number | null,
  config_version: 1,
};

async function getMerchantConfig(merchantId: string) {
  if (!supabaseAdmin || !merchantId) return DEFAULT_CONFIG;
  const { data, error } = await supabaseAdmin
    .from('loyalty_config')
    .select('*')
    .eq('merchant_id', merchantId)
    .maybeSingle();
  if (error) console.warn('[loyalty] getMerchantConfig error for', merchantId, ':', error.message);
  return data ?? DEFAULT_CONFIG;
}

/** Get or initialize the customer's active loyalty type from loyalty_member_profiles */
async function getCustomerActiveLoyaltyType(merchantId: string, customerId: string): Promise<string | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin.from('loyalty_member_profiles')
    .select('active_loyalty_type')
    .eq('customer_id', customerId).eq('merchant_id', merchantId)
    .maybeSingle();
  return data?.active_loyalty_type ?? null;
}

/** Set the customer's active loyalty type (only if not already set) */
async function initCustomerLoyaltyType(merchantId: string, customerId: string, loyaltyType: string): Promise<string> {
  if (!supabaseAdmin) return loyaltyType;
  // Try to set only if not already set (don't overwrite existing)
  const { data: existing } = await supabaseAdmin.from('loyalty_member_profiles')
    .select('active_loyalty_type')
    .eq('customer_id', customerId).eq('merchant_id', merchantId)
    .maybeSingle();

  if (existing?.active_loyalty_type) return existing.active_loyalty_type;

  // Set for the first time
  if (existing) {
    await supabaseAdmin.from('loyalty_member_profiles')
      .update({ active_loyalty_type: loyaltyType, loyalty_type_set_at: new Date().toISOString() })
      .eq('customer_id', customerId).eq('merchant_id', merchantId);
  }
  // If no profile exists yet, ensureLoyaltyMemberProfile will be called first by the earn/redeem handler
  return loyaltyType;
}

/**
 * Determines which loyalty system a customer should earn on and redeem from.
 *
 * Per-customer loyalty type rules:
 * - If customer type matches merchant type -> use it (no transition)
 * - If customer type differs from merchant type:
 *   - balance > 0 on old system -> keep old system (earn + redeem on old)
 *   - balance = 0 on old system -> auto-switch to new, update DB, notify pass
 * - If customer has no type -> assign merchant's current type
 * - loyalty_config.loyalty_type can be NULL (unactivated merchant)
 */
export async function getCustomerLoyaltyRoute(merchantId: string, customerId: string) {
  const config = await getMerchantConfig(merchantId);
  const merchantType = config.loyalty_type ?? null; // null = unactivated

  if (!merchantType) {
    // Merchant has not activated loyalty
    return { earn: null as string | null, redeem: null as string | null, transitioning: false, oldSystemType: null as string | null, oldBalance: 0 };
  }

  // Get the customer's own loyalty type
  const customerType = await getCustomerActiveLoyaltyType(merchantId, customerId);

  if (!customerType) {
    // New customer — assign them the merchant's current type
    const assignedType = await initCustomerLoyaltyType(merchantId, customerId, merchantType);
    return { earn: assignedType, redeem: assignedType, transitioning: false, oldSystemType: null, oldBalance: 0 };
  }

  // Customer type matches merchant type — no transition needed
  if (customerType === merchantType) {
    return { earn: customerType, redeem: customerType, transitioning: false, oldSystemType: null, oldBalance: 0 };
  }

  // Customer type differs from merchant type — check old system balance
  let oldBalance = 0;
  if (supabaseAdmin) {
    if (customerType === 'cashback') {
      const { data: cbData } = await supabaseAdmin
        .from('loyalty_cashback_balances')
        .select('balance_sar')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId)
        .order('config_version', { ascending: false })
        .limit(1)
        .maybeSingle();
      oldBalance = cbData?.balance_sar ?? 0;
    } else {
      // stamps (internally points) or legacy points
      const { data: ptsData } = await supabaseAdmin
        .from('loyalty_points')
        .select('points')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId)
        .maybeSingle();
      oldBalance = ptsData?.points ?? 0;
    }
  }

  if (oldBalance > 0) {
    // Keep old system until balance is spent
    return { earn: customerType, redeem: customerType, transitioning: true, oldSystemType: customerType, oldBalance };
  }

  // Balance is 0 — auto-switch to new system
  if (supabaseAdmin) {
    const now = new Date().toISOString();
    await supabaseAdmin.from('loyalty_member_profiles')
      .update({ active_loyalty_type: merchantType, loyalty_type_opted_in_at: now })
      .eq('customer_id', customerId).eq('merchant_id', merchantId);

    // Mark the transition as complete in the tracking table
    await supabaseAdmin.from('loyalty_customer_transitions')
      .upsert({
        customer_id: customerId,
        merchant_id: merchantId,
        from_loyalty_type: customerType,
        to_loyalty_type: merchantType,
        config_version_at_switch: config.config_version ?? 1,
        old_balance_exhausted: true,
        old_balance_exhausted_at: now,
      }, { onConflict: 'customer_id,merchant_id,config_version_at_switch' });

    // Trigger pass update so the design changes to the new loyalty type
    notifyPassUpdate(customerId, merchantId).catch((err) => console.warn('[Loyalty] notifyPassUpdate failed:', err instanceof Error ? err.message : err));
    console.log(`[loyalty] Auto-switched customer ${customerId.substring(0, 8)}… from ${customerType} to ${merchantType} (0 balance)`);
  }
  return { earn: merchantType, redeem: merchantType, transitioning: false, oldSystemType: customerType, oldBalance: 0 };
}

async function requireMatchingCustomer(
  req: Request,
  res: Response,
  customerId: string,
) {
  const user = await requireAuthenticatedAppUser(req, res);
  if (!user) return null;
  if (user.id !== customerId) {
    res.status(403).json({ error: 'Forbidden - loyalty data does not belong to authenticated user' });
    return null;
  }
  return user;
}

type LoyaltyActionContext = {
  source?: 'app' | 'branch' | 'system';
  branchId?: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  metadata?: Record<string, unknown>;
};

function normalizeOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildBranchReference(prefix: string, referenceId?: string | null) {
  const normalized = normalizeOptionalString(referenceId);
  return normalized ? `${prefix}:${normalized}` : `${prefix}:${Date.now()}`;
}

async function getLoyaltySnapshot(merchantId: string, customerId: string) {
  if (!supabaseAdmin) throw new Error('Database not configured');
  const member = await ensureLoyaltyMemberProfile(merchantId, customerId);
  const config = await getMerchantConfig(merchantId);

  const [{ data: balance }, { data: rewards }, { data: transactions }] = await Promise.all([
    supabaseAdmin
      .from('loyalty_points')
      .select('points, lifetime_points, updated_at')
      .eq('merchant_id', merchantId)
      .eq('customer_id', customerId)
      .maybeSingle(),
    supabaseAdmin
      .from('loyalty_rewards')
      .select('id, name, description, image_url, points_cost, is_active')
      .eq('merchant_id', merchantId)
      .eq('is_active', true)
      .order('points_cost', { ascending: true }),
    supabaseAdmin
      .from('loyalty_transactions')
      .select('id, type, points, description, branch_id, source, actor_role, reference_type, reference_id, expired, created_at')
      .eq('merchant_id', merchantId)
      .eq('customer_id', customerId)
      .neq('expired', true)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  const points = balance?.points ?? 0;
  const lifetimePoints = balance?.lifetime_points ?? 0;

  return {
    customerId,
    memberCode: member.member_code,
    displayName: member.display_name,
    phoneNumber: member.phone_number,
    email: member.email,
    points,
    lifetimePoints,
    pointsValueSar: +(points * config.point_value_sar).toFixed(2),
    pointValueSar: config.point_value_sar,
    rewards: rewards ?? [],
    recentTransactions: transactions ?? [],
  };
}

async function redeemPointsFromBalance(params: {
  customerId: string;
  merchantId: string;
  points: number;
  orderId: string;
  context?: LoyaltyActionContext;
}) {
  if (!supabaseAdmin) throw new Error('Database not configured');
  await ensureLoyaltyMemberProfile(params.merchantId, params.customerId);
  const config = await getMerchantConfig(params.merchantId);
  const programId = await getActiveProgramId(params.merchantId);
  const pointsToRedeem = Math.floor(Number(params.points));
  if (pointsToRedeem <= 0) throw new Error('Invalid points amount');

  let balQuery = supabaseAdmin
    .from('loyalty_points')
    .select('points')
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId);
  if (programId) balQuery = balQuery.eq('program_id', programId);
  const { data: balance } = await balQuery.single();

  if (!balance || balance.points < pointsToRedeem) {
    throw new Error(`Insufficient points. Available: ${balance?.points ?? 0}`);
  }

  const discountSar = +(pointsToRedeem * config.point_value_sar).toFixed(2);

  // Atomic conditional update: only deduct if balance still >= pointsToRedeem (prevents double-spend race)
  let updateQuery = supabaseAdmin
    .from('loyalty_points')
    .update({ points: balance.points - pointsToRedeem, updated_at: new Date().toISOString() })
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId)
    .gte('points', pointsToRedeem); // Guard: only succeeds if points still sufficient
  if (programId) updateQuery = updateQuery.eq('program_id', programId);
  const { data: updated, error: updateErr } = await updateQuery.select('points').maybeSingle();
  if (updateErr || !updated) {
    throw new Error('Redemption failed — balance may have changed. Please try again.');
  }

  await supabaseAdmin.from('loyalty_transactions').insert({
    customer_id: params.customerId,
    merchant_id: params.merchantId,
    order_id: params.orderId,
    type: 'redeem',
    points: -pointsToRedeem,
    description: `Redeemed ${pointsToRedeem} points for ${discountSar} SAR discount`,
    branch_id: normalizeOptionalString(params.context?.branchId),
    source: normalizeOptionalString(params.context?.source) ?? 'app',
    actor_user_id: normalizeOptionalString(params.context?.actorUserId),
    actor_role: normalizeOptionalString(params.context?.actorRole),
    reference_type: normalizeOptionalString(params.context?.referenceType),
    reference_id: normalizeOptionalString(params.context?.referenceId),
    metadata: params.context?.metadata ?? {},
    ...(programId ? { program_id: programId } : {}),
  });

  notifyPassUpdate(params.customerId, params.merchantId).catch((err) => console.warn('[Loyalty] notifyPassUpdate failed:', err instanceof Error ? err.message : err));
  return {
    success: true,
    pointsRedeemed: pointsToRedeem,
    discountSar,
    newBalance: balance.points - pointsToRedeem,
  };
}

async function redeemRewardFromBalance(params: {
  customerId: string;
  merchantId: string;
  rewardId: string;
  context?: LoyaltyActionContext;
}) {
  if (!supabaseAdmin) throw new Error('Database not configured');
  await ensureLoyaltyMemberProfile(params.merchantId, params.customerId);

  const { data: reward } = await supabaseAdmin
    .from('loyalty_rewards')
    .select('*')
    .eq('id', params.rewardId)
    .eq('merchant_id', params.merchantId)
    .eq('is_active', true)
    .single();
  if (!reward) throw new Error('Reward not found or inactive');

  const { data: balance } = await supabaseAdmin
    .from('loyalty_points')
    .select('points')
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId)
    .single();

  if (!balance || balance.points < reward.points_cost) {
    throw new Error(`Insufficient points. Available: ${balance?.points ?? 0}`);
  }

  const referenceId =
    normalizeOptionalString(params.context?.referenceId) ||
    `branch-reward:${params.rewardId}:${Date.now()}`;

  // Atomic conditional update: only deduct if balance still >= reward.points_cost (prevents double-spend race)
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('loyalty_points')
    .update({ points: balance.points - reward.points_cost, updated_at: new Date().toISOString() })
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId)
    .gte('points', reward.points_cost)
    .select('points')
    .maybeSingle();
  if (updateErr || !updated) {
    throw new Error('Redemption failed — balance may have changed. Please try again.');
  }

  await supabaseAdmin.from('loyalty_transactions').insert({
    customer_id: params.customerId,
    merchant_id: params.merchantId,
    order_id: referenceId,
    type: 'redeem',
    points: -reward.points_cost,
    description: `Redeemed reward: ${reward.name}`,
    branch_id: normalizeOptionalString(params.context?.branchId),
    source: normalizeOptionalString(params.context?.source) ?? 'app',
    actor_user_id: normalizeOptionalString(params.context?.actorUserId),
    actor_role: normalizeOptionalString(params.context?.actorRole),
    reference_type: normalizeOptionalString(params.context?.referenceType) ?? 'reward',
    reference_id: referenceId,
    metadata: { ...(params.context?.metadata ?? {}), reward_id: reward.id, reward_name: reward.name },
  });

  notifyPassUpdate(params.customerId, params.merchantId).catch((err) => console.warn('[Loyalty] notifyPassUpdate failed:', err instanceof Error ? err.message : err));
  return {
    success: true,
    reward: reward.name,
    pointsSpent: reward.points_cost,
    newBalance: balance.points - reward.points_cost,
  };
}

/* ── GET /api/loyalty/config?merchantId=X ── */
loyaltyRouter.get('/config', async (req, res) => {
  try {
    const merchantId = req.query.merchantId as string;
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
    const config = await getMerchantConfig(merchantId);
    res.json(config);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get config' });
  }
});

/* ── GET /api/loyalty/config/debug – check table columns ── */
loyaltyRouter.get('/config/debug', async (_req, res) => {
  if (!requireDiagnosticAccess(_req, res)) return;
  if (!supabaseAdmin) return res.json({ error: 'no supabaseAdmin' });
  const results: Record<string, unknown> = {};
  try {
    const { data: d1, error: e1 } = await supabaseAdmin.from('loyalty_points').select('*').limit(1);
    results.loyalty_points = e1 ? { error: e1.message, code: e1.code } : { ok: true, cols: d1?.[0] ? Object.keys(d1[0]) : 'empty' };
  } catch (err: any) { results.loyalty_points = { thrown: err?.message }; }
  try {
    const { data: d2, error: e2 } = await supabaseAdmin.from('loyalty_config').select('*').limit(1);
    results.loyalty_config = e2 ? { error: e2.message, code: e2.code, hint: e2.hint, details: e2.details } : { ok: true, cols: d2?.[0] ? Object.keys(d2[0]) : 'empty' };
  } catch (err: any) { results.loyalty_config = { thrown: err?.message }; }
  try {
    const { data: d3, error: e3 } = await supabaseAdmin.from('loyalty_transactions').select('*').limit(1);
    results.loyalty_transactions = e3 ? { error: e3.message, code: e3.code } : { ok: true, cols: d3?.[0] ? Object.keys(d3[0]) : 'empty' };
  } catch (err: any) { results.loyalty_transactions = { thrown: err?.message }; }
  return res.json(results);
});

/* ── PUT /api/loyalty/config ── */
loyaltyRouter.put('/config', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;

    const { merchantId, ...fields } = req.body;
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    // stamp_target is a platform-locked invariant (always 8). Removed from
    // the allowed list so a merchant can't change it via the dashboard;
    // the DB default + the seed in DEFAULT_LOYALTY_CONFIG handle the value.
    // Reasoning: at 8 stamps × 10 SAR floor, every "buy 8 get 1 free" card
    // is at minimum 80 SAR of real spend, which keeps the loyalty system
    // economic for the merchant and stops merchants from configuring
    // 2-stamp cards that hand out free items at 20 SAR.
    const allowed = [
      'loyalty_type', 'earn_mode', 'points_per_sar', 'points_per_order', 'point_value_sar',
      'cashback_percent',
      'expiry_months', 'stamp_enabled', 'stamp_reward_description',
      'wallet_card_bg_color', 'wallet_card_text_color', 'wallet_card_logo_url',
      'wallet_card_label', 'wallet_card_secondary_label', 'wallet_card_logo_scale',
      'wallet_card_banner_url', 'wallet_stamp_box_color', 'wallet_stamp_icon_color',
      'wallet_stamp_icon_url', 'wallet_stamp_icon_scale', 'business_type', 'pass_template_type',
    ];
    if ('stamp_target' in fields) {
      console.warn('[loyalty] Refusing to set stamp_target — platform-locked at 8');
    }

    // Config versioning: if loyalty_type or key rates changed, bump version
    const currentConfig = await getMerchantConfig(merchantId);
    const typeChanged = fields.loyalty_type && fields.loyalty_type !== currentConfig.loyalty_type;
    const rateChanged = (fields.cashback_percent != null && fields.cashback_percent !== currentConfig.cashback_percent)
      || (fields.points_per_sar != null && fields.points_per_sar !== currentConfig.points_per_sar)
      || (fields.point_value_sar != null && fields.point_value_sar !== currentConfig.point_value_sar);
    if (typeChanged || rateChanged) {
      fields.config_version = (currentConfig.config_version ?? 1) + 1;
      fields.previous_loyalty_type = currentConfig.loyalty_type ?? 'stamps';
      fields.config_changed_at = new Date().toISOString();
      allowed.push('config_version', 'previous_loyalty_type', 'config_changed_at');
    }
    const payload: Record<string, unknown> = { merchant_id: merchantId, updated_at: new Date().toISOString() };
    for (const k of allowed) {
      if (k in fields) payload[k] = fields[k];
    }

    console.log('[loyalty] PUT config payload:', JSON.stringify(payload));
    let { data, error } = await supabaseAdmin
      .from('loyalty_config')
      .upsert(payload, { onConflict: 'merchant_id' })
      .select();

    if (error && /wallet_card_logo_scale/i.test(error.message || '')) {
      const retryPayload = { ...payload };
      delete retryPayload.wallet_card_logo_scale;
      console.warn('[loyalty] wallet_card_logo_scale missing in DB; retrying save without it');
      const retry = await supabaseAdmin
        .from('loyalty_config')
        .upsert(retryPayload, { onConflict: 'merchant_id' })
        .select();
      data = retry.data;
      error = retry.error;
    }

    // Same fallback for wallet_stamp_icon_scale — if the new column hasn't
    // been applied yet (migration not run on this environment), drop it and
    // retry so the merchant's save doesn't fail outright.
    if (error && /wallet_stamp_icon_scale/i.test(error.message || '')) {
      const retryPayload = { ...payload };
      delete retryPayload.wallet_stamp_icon_scale;
      console.warn('[loyalty] wallet_stamp_icon_scale missing in DB; retrying save without it');
      const retry = await supabaseAdmin
        .from('loyalty_config')
        .upsert(retryPayload, { onConflict: 'merchant_id' })
        .select();
      data = retry.data;
      error = retry.error;
    }

    if (error) {
      console.error('[loyalty] upsert error:', error.message, error.code, error.hint, error.details);
      return res.status(500).json({ error: error.message, code: error.code, hint: error.hint });
    }
    console.log('[loyalty] upsert success:', JSON.stringify(data));
    res.json({ success: true });
  } catch (err: any) {
    const cause = (err as any)?.cause;
    console.error('[loyalty] PUT config exception:', err?.message, 'cause:', cause?.message || cause?.code || String(cause || 'none'));
    res.status(500).json({
      error: err?.message || 'Failed to save config',
      cause: cause?.message || cause?.code || String(cause || 'none'),
    });
  }
});

/* ── GET /api/loyalty/balance?customerId=X&merchantId=X ── */
loyaltyRouter.get('/balance', async (req, res) => {
  try {
    const customerId = req.query.customerId as string;
    const merchantId = req.query.merchantId as string;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
    if (!await requireMatchingCustomer(req, res, customerId)) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });
    const member = await ensureLoyaltyMemberProfile(merchantId, customerId);

    const config = await getMerchantConfig(merchantId);

    const { data } = await supabaseAdmin
      .from('loyalty_points')
      .select('points, lifetime_points')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .single();

    const points = data?.points ?? 0;
    const lifetimePoints = data?.lifetime_points ?? 0;
    const pointsValue = +(points * config.point_value_sar).toFixed(2);

    // The CUSTOMER'S effective loyalty type — not the raw config.
    // If the merchant changed type while the customer still has balance on
    // the old system, they keep the old type until the balance is spent.
    // Once the old balance reaches 0, this call auto-migrates them to the
    // merchant's current type (see getCustomerLoyaltyRoute for the logic).
    const route = await getCustomerLoyaltyRoute(merchantId, customerId);
    const loyaltyType = (route.redeem as 'cashback' | 'stamps' | null) ?? config.loyalty_type ?? 'stamps';

    // Stamps data
    let stamps = 0;
    let completedCards = 0;
    let stampMilestones: any[] = [];
    let availableRedemptions: any[] = [];
    if (loyaltyType === 'stamps' || config.stamp_enabled) {
      const [{ data: stampData }, { data: milestoneData }, { data: redemptionData }] = await Promise.all([
        supabaseAdmin.from('loyalty_stamps').select('stamps, completed_cards')
          .eq('customer_id', customerId).eq('merchant_id', merchantId).maybeSingle(),
        supabaseAdmin.from('loyalty_stamp_milestones').select('*')
          .eq('merchant_id', merchantId).eq('is_active', true).order('stamp_number', { ascending: true }),
        supabaseAdmin.from('loyalty_stamp_redemptions').select('*')
          .eq('customer_id', customerId).eq('merchant_id', merchantId)
          .is('redeemed_at', null),
      ]);
      stamps = stampData?.stamps ?? 0;
      completedCards = stampData?.completed_cards ?? 0;
      stampMilestones = milestoneData ?? [];
      availableRedemptions = redemptionData ?? [];
    }

    // Cashback balance
    let cashbackBalance = 0;
    if (loyaltyType === 'cashback') {
      const { data: cbData } = await supabaseAdmin
        .from('loyalty_cashback_balances')
        .select('balance_sar')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId)
        .order('config_version', { ascending: false })
        .limit(1)
        .maybeSingle();
      cashbackBalance = cbData?.balance_sar ?? 0;
    }

    res.json({
      loyaltyType,
      memberCode: member.member_code,
      // Transition state
      transitioning: route.transitioning,
      oldSystemType: route.oldSystemType,
      oldSystemBalance: route.oldBalance,
      redeemType: route.redeem, // which system the customer can redeem from
      // Points
      points,
      lifetimePoints,
      pointsValue,
      pointsPerSar: config.points_per_sar,
      pointsPerOrder: config.points_per_order,
      pointValueSar: config.point_value_sar,
      earnMode: config.earn_mode,
      expiryMonths: config.expiry_months,
      // Cashback
      cashbackBalance: +cashbackBalance.toFixed(2),
      cashbackPercent: config.cashback_percent ?? 5,
      maxCashbackPerOrderSar: config.max_cashback_per_order_sar ?? null,
      // Stamps
      stampEnabled: loyaltyType === 'stamps' || config.stamp_enabled,
      stampTarget: config.stamp_target,
      stampRewardDescription: config.stamp_reward_description,
      stamps,
      completedCards,
      stampMilestones,
      availableRedemptions,
      // Wallet card
      walletCardBgColor: config.wallet_card_bg_color || null,
      walletCardTextColor: config.wallet_card_text_color || null,
      walletCardLogoUrl: config.wallet_card_logo_url || null,
      walletCardLabel: config.wallet_card_label || null,
      walletCardSecondaryLabel: config.wallet_card_secondary_label || null,
      walletCardBannerUrl: config.wallet_card_banner_url || null,
      walletStampBoxColor: config.wallet_stamp_box_color || null,
      walletStampIconColor: config.wallet_stamp_icon_color || null,
      walletStampIconUrl: config.wallet_stamp_icon_url || null,
      businessType: config.business_type || 'cafe',
      walletCardLogoScale:
        config.wallet_card_logo_scale != null ? Number(config.wallet_card_logo_scale) : null,
      walletStampIconScale:
        config.wallet_stamp_icon_scale != null ? Number(config.wallet_stamp_icon_scale) : null,
      // Cache-bust signal for the customer app's local .pkpass cache.
      // The customer app keys its AsyncStorage pass cache by this value
      // so any save in the merchant's Loyalty dashboard (which bumps
      // updated_at on the loyalty_config row) automatically invalidates
      // the cached pass on the next Add-to-Wallet press. Pre-install
      // preview always reflects the latest design.
      configUpdatedAt: config.updated_at ?? null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get loyalty balance' });
  }
});

/* ── POST /api/loyalty/earn ── */
loyaltyRouter.post('/earn', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;

    const { customerId, orderId, orderSubtotal, merchantId } = req.body;
    if (!customerId || !orderId || orderSubtotal == null) {
      return res.status(400).json({ error: 'customerId, orderId, and orderSubtotal required' });
    }
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    // Branch by loyalty type (per-customer)
    const config = await getMerchantConfig(merchantId || '');
    if (!config.loyalty_type) {
      return res.status(400).json({ error: 'Loyalty is not activated for this merchant' });
    }

    // Defense-in-depth (Tier 2 audit): the endpoint is restricted to
    // internal nooksweb callers via requireNooksInternalRequest, but we
    // still want to validate orderId server-side so a buggy or
    // compromised internal caller can't grant stamps/cashback for a
    // fabricated, cancelled, or refunded order. Cancellation routes set
    // status='Cancelled', so excluding that one status is sufficient —
    // any other lifecycle state (Pending, Preparing, Ready, Delivered)
    // means the customer has paid and the merchant accepted it.
    const orderCheck = await supabaseAdmin
      .from('customer_orders')
      .select('id, status, customer_id, merchant_id, total_sar')
      .eq('id', orderId)
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId || '')
      .maybeSingle();
    if (!orderCheck.data) {
      return res.status(404).json({ error: 'Order not found for this customer + merchant' });
    }
    if (orderCheck.data.status === 'Cancelled') {
      return res.status(409).json({ error: 'Cannot earn loyalty on a cancelled order' });
    }

    await ensureLoyaltyMemberProfile(merchantId || '', customerId);
    const customerType = await initCustomerLoyaltyType(merchantId || '', customerId, config.loyalty_type);
    const loyaltyType = customerType;

    if (loyaltyType === 'cashback') {
      const result = await earnCashback(merchantId || '', customerId, orderId, Number(orderSubtotal));
      return res.json(result);
    }

    if (loyaltyType === 'stamps') {
      // ─── Minimum order subtotal for a stamp (anti-spam) ───
      // Without a floor a malicious customer could spam an order of
      // a 1-SAR item to farm stamps. Anything below 10 SAR is treated
      // as ineligible — order still completes normally, but no stamp
      // is granted. The merchant can no longer override this floor;
      // it's a platform invariant, like the locked stamp_target=8.
      const STAMP_MIN_SUBTOTAL_SAR = 10;
      if (Number(orderSubtotal) < STAMP_MIN_SUBTOTAL_SAR) {
        return res.json({
          success: true,
          stampSkipped: true,
          reason: 'below_minimum_subtotal',
          minSubtotalSar: STAMP_MIN_SUBTOTAL_SAR,
          stamps: 0,
          milestoneReached: false,
        });
      }

      // Idempotency: if we've already stamped this order, short-circuit.
      // Without this, any webhook replay that squeaks past the regression
      // guard in the Foodics handler would double-stamp the customer.
      // Cashback has the same check (see earnCashback).
      const { data: alreadyStamped } = await supabaseAdmin
        .from('loyalty_transactions')
        .select('id')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId || '')
        .eq('order_id', orderId)
        .eq('type', 'earn')
        .eq('loyalty_type', 'stamps')
        .limit(1)
        .maybeSingle();
      if (alreadyStamped) {
        const { data: stampRow } = await supabaseAdmin
          .from('loyalty_stamps')
          .select('stamps, completed_cards')
          .eq('customer_id', customerId)
          .eq('merchant_id', merchantId || '')
          .maybeSingle();
        return res.json({
          success: true,
          alreadyEarned: true,
          stamps: stampRow?.stamps ?? 0,
          milestoneReached: false,
        });
      }

      // Increment stamp count
      const { data: stampRow } = await supabaseAdmin.from('loyalty_stamps')
        .select('stamps, completed_cards')
        .eq('customer_id', customerId).eq('merchant_id', merchantId || '').maybeSingle();

      const newStamps = (stampRow?.stamps ?? 0) + 1;
      if (stampRow) {
        await supabaseAdmin.from('loyalty_stamps')
          .update({ stamps: newStamps, updated_at: new Date().toISOString() })
          .eq('customer_id', customerId).eq('merchant_id', merchantId || '');
      } else {
        await supabaseAdmin.from('loyalty_stamps').insert({
          customer_id: customerId, merchant_id: merchantId || '',
          stamps: newStamps, completed_cards: 0,
        });
      }

      // INTERNAL ACCOUNTING ONLY: 1 stamp = 10 internal points.
      // These points are stored in our loyalty_points table for balance tracking.
      // Foodics does NOT receive these points — Foodics integration uses the adapter
      // pattern (nooksweb /api/adapter/v1/reward + /redeem endpoints).
      // The QR code on the Apple Wallet pass contains customer mobile + country code
      // in Foodics-compatible JSON format for POS scanning.
      const pointsForStamp = 10;
      const { data: ptsBal } = await supabaseAdmin.from('loyalty_points')
        .select('points, lifetime_points')
        .eq('customer_id', customerId).eq('merchant_id', merchantId || '').maybeSingle();
      if (ptsBal) {
        await supabaseAdmin.from('loyalty_points')
          .update({ points: ptsBal.points + pointsForStamp, lifetime_points: ptsBal.lifetime_points + pointsForStamp, updated_at: new Date().toISOString() })
          .eq('customer_id', customerId).eq('merchant_id', merchantId || '');
      } else {
        await supabaseAdmin.from('loyalty_points').insert({
          customer_id: customerId, merchant_id: merchantId || '',
          points: pointsForStamp, lifetime_points: pointsForStamp,
        });
      }

      // Per-purchase expiry: each stamp earn gets its own expiry date
      const stampExpiresAt = config.expiry_months
        ? (() => { const d = new Date(); d.setMonth(d.getMonth() + config.expiry_months!); return d.toISOString(); })()
        : null;

      await supabaseAdmin.from('loyalty_transactions').insert({
        customer_id: customerId, merchant_id: merchantId || '', order_id: orderId,
        type: 'earn', loyalty_type: 'stamps', points: pointsForStamp,
        description: `Earned 1 stamp (order completed)`, source: 'app',
        expires_at: stampExpiresAt,
      });

      // Check if any milestone was reached (highest milestone where stamp_number <= newStamps)
      const { data: milestones } = await supabaseAdmin.from('loyalty_stamp_milestones')
        .select('id, stamp_number, reward_name, foodics_product_ids')
        .eq('merchant_id', merchantId || '').eq('is_active', true)
        .lte('stamp_number', newStamps)
        .order('stamp_number', { ascending: false })
        .limit(1);

      // Filter out milestones already awarded (unredeemed redemption exists)
      if (milestones && milestones.length > 0) {
        const { data: existingRedemption } = await supabaseAdmin.from('loyalty_stamp_redemptions')
          .select('id')
          .eq('customer_id', customerId).eq('merchant_id', merchantId || '')
          .eq('milestone_id', milestones[0].id).is('redeemed_at', null)
          .maybeSingle();
        if (existingRedemption) {
          // Already has an unredeemed reward for this milestone — don't create another
          milestones.length = 0;
        }
      }

      let milestoneReached = false;
      let milestoneName = '';
      if (milestones && milestones.length > 0) {
        const hit = milestones[0];
        milestoneReached = true;
        milestoneName = hit.reward_name;

        // Create redemption record (redeemable at branch via Foodics adapter or in-app)
        await supabaseAdmin.from('loyalty_stamp_redemptions').insert({
          customer_id: customerId, merchant_id: merchantId || '',
          milestone_id: hit.id, stamp_number: hit.stamp_number,
        });

        // Push notification to customer — localized per device using
        // push_subscriptions.app_language. Merchant-scoped so the same
        // auth.uid installed across multiple merchant apps doesn't get
        // the milestone-unlock push fanned out to every brand.
        sendLocalizedPushScoped({
          customerId,
          merchantId: merchantId || '',
          channel: 'loyalty',
          copy: {
            en: {
              title: 'Milestone Reward Unlocked!',
              body: `You earned ${hit.stamp_number} stamps! Your reward: ${hit.reward_name}. Show your wallet card at the branch or redeem in the app.`,
            },
            ar: {
              title: 'فزت بمكافأة!',
              body: `جمعت ${hit.stamp_number} ختمة! المكافأة: ${hit.reward_name}. اعرض بطاقة المحفظة في الفرع أو استبدلها من التطبيق.`,
            },
          },
        });
      }

      notifyPassUpdate(customerId, merchantId || '').catch((err) => console.warn('[Loyalty] notifyPassUpdate failed:', err instanceof Error ? err.message : err));
      return res.json({
        success: true, pointsEarned: pointsForStamp, newStamps, milestoneReached, milestoneName,
        newBalance: (ptsBal?.points ?? 0) + pointsForStamp,
      });
    }

    // Default: points
    const result = await earnPoints(customerId, orderId, Number(orderSubtotal), merchantId || '');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to earn' });
  }
});

/**
 * Shared earn logic – callable from routes and from order status handler
 */
export async function earnPoints(
  customerId: string,
  orderId: string,
  orderSubtotal: number,
  merchantId: string,
  context?: LoyaltyActionContext,
): Promise<{ success: boolean; pointsEarned: number; newBalance: number; stampAwarded?: boolean; stampRewardGranted?: boolean }> {
  if (!supabaseAdmin) throw new Error('Database not configured');
  await ensureLoyaltyMemberProfile(merchantId, customerId);

  // Resolve active loyalty program (null = legacy/no programs configured)
  const programId = await getActiveProgramId(merchantId);

  let idempotencyQuery = supabaseAdmin
    .from('loyalty_transactions')
    .select('id')
    .eq('customer_id', customerId)
    .eq('merchant_id', merchantId)
    .eq('order_id', orderId)
    .eq('type', 'earn')
    .gt('points', 0)
    .limit(1);
  if (programId) idempotencyQuery = idempotencyQuery.eq('program_id', programId);
  const { data: alreadyEarned } = await idempotencyQuery.maybeSingle();

  if (alreadyEarned) {
    let balQuery = supabaseAdmin
      .from('loyalty_points')
      .select('points')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId);
    if (programId) balQuery = balQuery.eq('program_id', programId);
    const { data: existingBalance } = await balQuery.maybeSingle();

    return {
      success: true,
      pointsEarned: 0,
      newBalance: existingBalance?.points ?? 0,
      stampAwarded: false,
      stampRewardGranted: false,
    };
  }

  const config = await getMerchantConfig(merchantId);

  const pointsEarned = config.earn_mode === 'per_order'
    ? Math.floor(config.points_per_order)
    : Math.floor(orderSubtotal * config.points_per_sar);

  const expiresAt = config.expiry_months
    ? (() => { const d = new Date(); d.setMonth(d.getMonth() + config.expiry_months!); return d.toISOString(); })()
    : null;

  let existQuery = supabaseAdmin
    .from('loyalty_points')
    .select('points, lifetime_points')
    .eq('customer_id', customerId)
    .eq('merchant_id', merchantId);
  if (programId) existQuery = existQuery.eq('program_id', programId);
  const { data: existing } = await existQuery.single();

  if (existing) {
    let updateQuery = supabaseAdmin
      .from('loyalty_points')
      .update({
        points: existing.points + pointsEarned,
        lifetime_points: existing.lifetime_points + pointsEarned,
        updated_at: new Date().toISOString(),
      })
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId);
    if (programId) updateQuery = updateQuery.eq('program_id', programId);
    await updateQuery;
  } else {
    await supabaseAdmin.from('loyalty_points').insert({
      customer_id: customerId,
      merchant_id: merchantId,
      points: pointsEarned,
      lifetime_points: pointsEarned,
      ...(programId ? { program_id: programId } : {}),
    });
  }

  await supabaseAdmin.from('loyalty_transactions').insert({
    customer_id: customerId,
    merchant_id: merchantId,
    order_id: orderId,
    type: 'earn',
    points: pointsEarned,
    description: `Earned ${pointsEarned} points`,
    expires_at: expiresAt,
    branch_id: normalizeOptionalString(context?.branchId),
    source: normalizeOptionalString(context?.source) ?? 'app',
    actor_user_id: normalizeOptionalString(context?.actorUserId),
    actor_role: normalizeOptionalString(context?.actorRole),
    reference_type: normalizeOptionalString(context?.referenceType),
    reference_id: normalizeOptionalString(context?.referenceId),
    metadata: context?.metadata ?? {},
    ...(programId ? { program_id: programId } : {}),
  });

  let stampAwarded = false;
  let stampRewardGranted = false;
  if (config.stamp_enabled && merchantId) {
    let stampQuery = supabaseAdmin
      .from('loyalty_stamps')
      .select('stamps, completed_cards')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId);
    if (programId) stampQuery = stampQuery.eq('program_id', programId);
    const { data: stampRow } = await stampQuery.single();

    let newStamps = (stampRow?.stamps ?? 0) + 1;
    let completedCards = stampRow?.completed_cards ?? 0;
    stampAwarded = true;

    if (newStamps >= config.stamp_target) {
      completedCards += 1;
      newStamps = 0;
      stampRewardGranted = true;

      await supabaseAdmin.from('loyalty_transactions').insert({
        customer_id: customerId,
        merchant_id: merchantId,
        order_id: orderId,
        type: 'earn',
        points: 0,
        description: `Stamp card completed! ${config.stamp_reward_description}`,
        branch_id: normalizeOptionalString(context?.branchId),
        source: normalizeOptionalString(context?.source) ?? 'app',
        actor_user_id: normalizeOptionalString(context?.actorUserId),
        actor_role: normalizeOptionalString(context?.actorRole),
        reference_type: normalizeOptionalString(context?.referenceType),
        reference_id: normalizeOptionalString(context?.referenceId),
        metadata: context?.metadata ?? {},
        ...(programId ? { program_id: programId } : {}),
      });
    }

    if (stampRow) {
      let stampUpdateQuery = supabaseAdmin
        .from('loyalty_stamps')
        .update({ stamps: newStamps, completed_cards: completedCards, updated_at: new Date().toISOString() })
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId);
      if (programId) stampUpdateQuery = stampUpdateQuery.eq('program_id', programId);
      await stampUpdateQuery;
    } else {
      await supabaseAdmin.from('loyalty_stamps').insert({
        customer_id: customerId,
        merchant_id: merchantId,
        stamps: newStamps,
        completed_cards: completedCards,
        ...(programId ? { program_id: programId } : {}),
      });
    }
  }

  notifyPassUpdate(customerId, merchantId).catch((err) => console.warn('[Loyalty] notifyPassUpdate failed:', err instanceof Error ? err.message : err));

  return {
    success: true,
    pointsEarned,
    newBalance: (existing?.points ?? 0) + pointsEarned,
    stampAwarded,
    stampRewardGranted,
  };
}

/* ── POST /api/loyalty/redeem ── */
loyaltyRouter.post('/redeem', async (req, res) => {
  try {
    const { customerId, points, orderId, merchantId } = req.body;
    if (!customerId || !points || !orderId) {
      return res.status(400).json({ error: 'customerId, points, and orderId required' });
    }
    // Accept either: user auth (app checkout) OR internal secret (Foodics adapter via nooksweb)
    const hasInternalSecret = req.headers['x-nooks-internal-secret'] === (process.env.NOOKS_INTERNAL_SECRET || '').trim();
    if (!hasInternalSecret) {
      if (!await requireMatchingCustomer(req, res, customerId)) return;
    }
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });
    const result = await redeemPointsFromBalance({
      customerId,
      merchantId: merchantId || '',
      points: Number(points),
      orderId,
      context: { source: 'app' },
    });
    res.json(result);
  } catch (err: any) {
    const message = err?.message || 'Failed to redeem points';
    const status = /insufficient points|invalid points/i.test(message) ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

/* ── POST /api/loyalty/redeem-reward ── */
loyaltyRouter.post('/redeem-reward', async (req, res) => {
  try {
    const { customerId, rewardId, merchantId } = req.body;
    if (!customerId || !rewardId) return res.status(400).json({ error: 'customerId and rewardId required' });
    if (!await requireMatchingCustomer(req, res, customerId)) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });
    const result = await redeemRewardFromBalance({
      customerId,
      merchantId: merchantId || '',
      rewardId,
      context: { source: 'app' },
    });
    res.json(result);
  } catch (err: any) {
    const message = err?.message || 'Failed to redeem reward';
    const status =
      /insufficient points|not found|inactive/i.test(message) ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

/* ── GET /api/loyalty/rewards?merchantId=X ── */
loyaltyRouter.get('/rewards', async (req, res) => {
  try {
    const merchantId = req.query.merchantId as string;
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabaseAdmin
      .from('loyalty_rewards')
      .select('*')
      .eq('merchant_id', merchantId)
      .eq('is_active', true)
      .order('points_cost', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ rewards: data ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get rewards' });
  }
});

/* ── POST /api/loyalty/rewards ── */
loyaltyRouter.post('/rewards', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;

    const { merchantId, name, description, image_url, points_cost } = req.body;
    if (!merchantId || !name || !points_cost) return res.status(400).json({ error: 'merchantId, name, and points_cost required' });
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabaseAdmin
      .from('loyalty_rewards')
      .insert({ merchant_id: merchantId, name, description, image_url, points_cost: Number(points_cost) })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, reward: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to create reward' });
  }
});

/* ── PUT /api/loyalty/rewards/:id ── */
loyaltyRouter.put('/rewards/:id', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;

    const { name, description, image_url, points_cost, is_active } = req.body;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (image_url !== undefined) updates.image_url = image_url;
    if (points_cost !== undefined) updates.points_cost = Number(points_cost);
    if (is_active !== undefined) updates.is_active = is_active;

    const { error } = await supabaseAdmin.from('loyalty_rewards').update(updates).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update reward' });
  }
});

/* ── DELETE /api/loyalty/rewards/:id ── */
loyaltyRouter.delete('/rewards/:id', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;

    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });
    const { error } = await supabaseAdmin.from('loyalty_rewards').update({ is_active: false }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to delete reward' });
  }
});

/* ── GET /api/loyalty/branch/member?merchantId=X&lookup=Y ── */
loyaltyRouter.get('/branch/member', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;
    const merchantId = normalizeOptionalString(req.query.merchantId);
    const lookup = normalizeOptionalString(req.query.lookup);
    if (!merchantId || !lookup) {
      return res.status(400).json({ error: 'merchantId and lookup are required' });
    }
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const member = await findLoyaltyMemberByLookup(merchantId, lookup);
    if (!member) {
      return res.status(404).json({ error: 'Loyalty member not found for this merchant' });
    }

    const snapshot = await getLoyaltySnapshot(merchantId, member.customer_id);
    res.json({ success: true, member: snapshot });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to look up loyalty member' });
  }
});

/* ── POST /api/loyalty/branch/earn ── */
loyaltyRouter.post('/branch/earn', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;
    const merchantId = normalizeOptionalString(req.body?.merchantId);
    const branchId = normalizeOptionalString(req.body?.branchId);
    const lookup = normalizeOptionalString(req.body?.lookup);
    const actorUserId = normalizeOptionalString(req.body?.actorUserId);
    const actorRole = normalizeOptionalString(req.body?.actorRole);
    const referenceId = normalizeOptionalString(req.body?.referenceId);
    const amountSar = Number(req.body?.amountSar);
    if (!merchantId || !branchId || !lookup || !actorUserId || !actorRole || !referenceId || !Number.isFinite(amountSar) || amountSar <= 0) {
      return res.status(400).json({
        error: 'merchantId, branchId, lookup, actorUserId, actorRole, referenceId, and positive amountSar are required',
      });
    }

    const member = await findLoyaltyMemberByLookup(merchantId, lookup);
    if (!member) return res.status(404).json({ error: 'Loyalty member not found for this merchant' });

    const orderId = buildBranchReference('branch-sale', referenceId);
    const result = await earnPoints(member.customer_id, orderId, amountSar, merchantId, {
      source: 'branch',
      branchId,
      actorUserId,
      actorRole,
      referenceType: 'branch_sale',
      referenceId,
      metadata: {
        note: normalizeOptionalString(req.body?.note),
        amount_sar: amountSar,
      },
    });
    const snapshot = await getLoyaltySnapshot(merchantId, member.customer_id);
    res.json({ success: true, result, member: snapshot });
  } catch (err: any) {
    const message = err?.message || 'Failed to earn branch loyalty points';
    const status = /not found|required|invalid/i.test(message) ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

/* ── POST /api/loyalty/branch/redeem-points ── */
loyaltyRouter.post('/branch/redeem-points', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;
    const merchantId = normalizeOptionalString(req.body?.merchantId);
    const branchId = normalizeOptionalString(req.body?.branchId);
    const lookup = normalizeOptionalString(req.body?.lookup);
    const actorUserId = normalizeOptionalString(req.body?.actorUserId);
    const actorRole = normalizeOptionalString(req.body?.actorRole);
    const referenceId = normalizeOptionalString(req.body?.referenceId);
    const points = Number(req.body?.points);
    if (!merchantId || !branchId || !lookup || !actorUserId || !actorRole || !referenceId || !Number.isFinite(points) || points <= 0) {
      return res.status(400).json({
        error: 'merchantId, branchId, lookup, actorUserId, actorRole, referenceId, and positive points are required',
      });
    }

    const member = await findLoyaltyMemberByLookup(merchantId, lookup);
    if (!member) return res.status(404).json({ error: 'Loyalty member not found for this merchant' });

    const result = await redeemPointsFromBalance({
      customerId: member.customer_id,
      merchantId,
      points,
      orderId: buildBranchReference('branch-redeem', referenceId),
      context: {
        source: 'branch',
        branchId,
        actorUserId,
        actorRole,
        referenceType: 'branch_redeem',
        referenceId,
        metadata: { note: normalizeOptionalString(req.body?.note) },
      },
    });
    const snapshot = await getLoyaltySnapshot(merchantId, member.customer_id);
    res.json({ success: true, result, member: snapshot });
  } catch (err: any) {
    const message = err?.message || 'Failed to redeem branch loyalty points';
    const status = /insufficient points|required|invalid|not found/i.test(message) ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

/* ── POST /api/loyalty/branch/redeem-reward ── */
loyaltyRouter.post('/branch/redeem-reward', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;
    const merchantId = normalizeOptionalString(req.body?.merchantId);
    const branchId = normalizeOptionalString(req.body?.branchId);
    const lookup = normalizeOptionalString(req.body?.lookup);
    const rewardId = normalizeOptionalString(req.body?.rewardId);
    const actorUserId = normalizeOptionalString(req.body?.actorUserId);
    const actorRole = normalizeOptionalString(req.body?.actorRole);
    const referenceId = normalizeOptionalString(req.body?.referenceId);
    if (!merchantId || !branchId || !lookup || !rewardId || !actorUserId || !actorRole || !referenceId) {
      return res.status(400).json({
        error: 'merchantId, branchId, lookup, rewardId, actorUserId, actorRole, and referenceId are required',
      });
    }

    const member = await findLoyaltyMemberByLookup(merchantId, lookup);
    if (!member) return res.status(404).json({ error: 'Loyalty member not found for this merchant' });

    const result = await redeemRewardFromBalance({
      customerId: member.customer_id,
      merchantId,
      rewardId,
      context: {
        source: 'branch',
        branchId,
        actorUserId,
        actorRole,
        referenceType: 'branch_reward',
        referenceId,
        metadata: { note: normalizeOptionalString(req.body?.note) },
      },
    });
    const snapshot = await getLoyaltySnapshot(merchantId, member.customer_id);
    res.json({ success: true, result, member: snapshot });
  } catch (err: any) {
    const message = err?.message || 'Failed to redeem branch loyalty reward';
    const status = /insufficient points|required|not found|inactive/i.test(message) ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

/* ── GET /api/loyalty/history?customerId=X&merchantId=X ── */
loyaltyRouter.get('/history', async (req, res) => {
  try {
    const customerId = req.query.customerId as string;
    const merchantId = req.query.merchantId as string;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    // merchantId is now REQUIRED. Without it, this endpoint returned the
    // union of every loyalty transaction the customer ever earned across
    // every merchant they've used — a multi-tenant data leak when the
    // same Supabase auth.uid is logged into two different merchants'
    // apps. The mobile app already always sends merchantId; rejecting
    // omitted merchantId here is defense-in-depth.
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
    if (!await requireMatchingCustomer(req, res, customerId)) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabaseAdmin
      .from('loyalty_transactions')
      .select('*')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ transactions: data ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get history' });
  }
});


/* ═══════════════════════════════════════════════════════════════════
   CASHBACK — earn and redeem real SAR
   ═══════════════════════════════════════════════════════════════════ */

/** Earn cashback on a completed order */
async function earnCashback(merchantId: string, customerId: string, orderId: string, orderSubtotal: number) {
  if (!supabaseAdmin) throw new Error('Database not configured');
  const config = await getMerchantConfig(merchantId);
  const percent = config.cashback_percent ?? 5;
  const cashbackSar = +(orderSubtotal * percent / 100).toFixed(2);
  if (cashbackSar <= 0) return { success: true, cashbackEarned: 0, newBalance: 0 };

  // Idempotency: check if already earned for this order
  const { data: existing } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id')
    .eq('customer_id', customerId).eq('merchant_id', merchantId)
    .eq('order_id', orderId).eq('type', 'earn').eq('loyalty_type', 'cashback')
    .limit(1).maybeSingle();
  if (existing) {
    const { data: bal } = await supabaseAdmin.from('loyalty_cashback_balances')
      .select('balance_sar').eq('customer_id', customerId).eq('merchant_id', merchantId)
      .order('config_version', { ascending: false }).limit(1).maybeSingle();
    return { success: true, cashbackEarned: 0, newBalance: bal?.balance_sar ?? 0, alreadyEarned: true };
  }

  // Upsert balance
  const { data: balRow } = await supabaseAdmin.from('loyalty_cashback_balances')
    .select('balance_sar, config_version')
    .eq('customer_id', customerId).eq('merchant_id', merchantId)
    .order('config_version', { ascending: false }).limit(1).maybeSingle();

  const currentVersion = config.config_version ?? 1;
  if (balRow) {
    await supabaseAdmin.from('loyalty_cashback_balances')
      .update({ balance_sar: +(balRow.balance_sar + cashbackSar).toFixed(2), updated_at: new Date().toISOString() })
      .eq('customer_id', customerId).eq('merchant_id', merchantId).eq('config_version', balRow.config_version);
  } else {
    await supabaseAdmin.from('loyalty_cashback_balances').insert({
      customer_id: customerId, merchant_id: merchantId,
      balance_sar: cashbackSar, config_version: currentVersion,
    });
  }

  const expiresAt = config.expiry_months
    ? (() => { const d = new Date(); d.setMonth(d.getMonth() + config.expiry_months!); return d.toISOString(); })()
    : null;

  await supabaseAdmin.from('loyalty_transactions').insert({
    customer_id: customerId, merchant_id: merchantId, order_id: orderId,
    type: 'earn', loyalty_type: 'cashback', amount_sar: cashbackSar,
    points: 0, description: `Earned ${cashbackSar} SAR cashback`,
    source: 'app', expires_at: expiresAt, config_version: currentVersion,
  });

  notifyPassUpdate(customerId, merchantId).catch((err) => console.warn('[Loyalty] notifyPassUpdate failed:', err instanceof Error ? err.message : err));
  return { success: true, cashbackEarned: cashbackSar, newBalance: +((balRow?.balance_sar ?? 0) + cashbackSar).toFixed(2) };
}

/* ═══════════════════════════════════════════════════════════════════
   ORDER-REVERSAL HELPERS — called by server/routes/orders.ts when an
   order is cancelled/refused. Each restores one loyalty source back to
   the customer (cashback balance or stamps + redemption rows) so the
   net effect of placing-then-cancelling is zero. Idempotent on
   (customer, merchant, order_id, source='refund') via a marker
   transaction; safe to call multiple times if the cancel flow retries.
   ═══════════════════════════════════════════════════════════════════ */

export async function restoreCashbackForRefund(params: {
  customerId: string;
  merchantId: string;
  amountSar: number;
  orderId: string;
}): Promise<{ restoredSar: number; alreadyRestored: boolean }> {
  if (!supabaseAdmin) throw new Error('Database not configured');
  const amount = +Number(params.amountSar).toFixed(2);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { restoredSar: 0, alreadyRestored: false };
  }

  // Idempotency marker — a prior reversal row blocks the re-run. We
  // key on (order_id, type='earn', loyalty_type='cashback',
  // source='refund') which is unique to this exact reversal action.
  const { data: priorReverse } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id, amount_sar')
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId)
    .eq('order_id', params.orderId)
    .eq('type', 'earn')
    .eq('loyalty_type', 'cashback')
    .eq('source', 'refund')
    .maybeSingle();
  if (priorReverse) {
    return { restoredSar: Math.abs(Number(priorReverse.amount_sar ?? 0)), alreadyRestored: true };
  }

  // Find the latest balance row (highest config_version) and add back.
  const { data: balRow } = await supabaseAdmin
    .from('loyalty_cashback_balances')
    .select('balance_sar, config_version')
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId)
    .order('config_version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const configVersion = balRow?.config_version ?? 1;
  const newBalance = +(((balRow?.balance_sar ?? 0) as number) + amount).toFixed(2);

  if (balRow) {
    await supabaseAdmin
      .from('loyalty_cashback_balances')
      .update({ balance_sar: newBalance, updated_at: new Date().toISOString() })
      .eq('customer_id', params.customerId)
      .eq('merchant_id', params.merchantId)
      .eq('config_version', configVersion);
  } else {
    await supabaseAdmin.from('loyalty_cashback_balances').insert({
      customer_id: params.customerId,
      merchant_id: params.merchantId,
      balance_sar: amount,
      config_version: 1,
    });
  }

  await supabaseAdmin.from('loyalty_transactions').insert({
    customer_id: params.customerId,
    merchant_id: params.merchantId,
    order_id: params.orderId,
    type: 'earn',
    loyalty_type: 'cashback',
    amount_sar: amount,
    points: 0,
    description: `Refunded cashback from cancelled order ${params.orderId.slice(-8)}`,
    source: 'refund',
    config_version: configVersion,
  });

  notifyPassUpdate(params.customerId, params.merchantId).catch((err) =>
    console.warn('[Loyalty] notifyPassUpdate failed after cashback refund:', err instanceof Error ? err.message : err),
  );
  return { restoredSar: amount, alreadyRestored: false };
}

export async function restoreStampMilestonesForRefund(params: {
  customerId: string;
  merchantId: string;
  milestoneIds: string[];
  stampsConsumed: number;
  orderId: string;
}): Promise<{ stampsRestored: number; milestonesCleared: string[]; alreadyRestored: boolean }> {
  if (!supabaseAdmin) throw new Error('Database not configured');
  if (params.milestoneIds.length === 0 || params.stampsConsumed <= 0) {
    return { stampsRestored: 0, milestonesCleared: [], alreadyRestored: false };
  }

  // Idempotency marker — same pattern as cashback.
  const { data: priorReverse } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id, points')
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId)
    .eq('order_id', params.orderId)
    .eq('type', 'earn')
    .eq('loyalty_type', 'stamps')
    .eq('source', 'refund')
    .maybeSingle();
  if (priorReverse) {
    return { stampsRestored: 0, milestonesCleared: [], alreadyRestored: true };
  }

  // Add stamps back. We use a non-atomic read+write because nobody
  // else is racing to modify stamps at refund time (the order is in
  // 'Cancelled' transition; no concurrent earn/redeem expected).
  const { data: stampRow } = await supabaseAdmin
    .from('loyalty_stamps')
    .select('stamps')
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId)
    .maybeSingle();
  const newStamps = (stampRow?.stamps ?? 0) + params.stampsConsumed;
  if (stampRow) {
    await supabaseAdmin
      .from('loyalty_stamps')
      .update({ stamps: newStamps, updated_at: new Date().toISOString() })
      .eq('customer_id', params.customerId)
      .eq('merchant_id', params.merchantId);
  } else {
    await supabaseAdmin.from('loyalty_stamps').insert({
      customer_id: params.customerId,
      merchant_id: params.merchantId,
      stamps: params.stampsConsumed,
    });
  }

  // Clear redemption rows so the milestone is available again. The
  // checkout redeem step either flips an existing unredeemed row's
  // redeemed_at to NOT-NULL OR inserts a fresh row — either way the
  // row now has redeemed_at set. Setting it back to NULL makes the
  // milestone re-eligible for redemption next checkout. We don't
  // DELETE the row because keeping the history is useful for ops.
  const { data: clearedRows } = await supabaseAdmin
    .from('loyalty_stamp_redemptions')
    .update({ redeemed_at: null, redeemed_via: null })
    .in('milestone_id', params.milestoneIds)
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId)
    .not('redeemed_at', 'is', null)
    .select('milestone_id');

  // Refund the internal points (1 stamp = 10 internal points, mirrors
  // the deduct in redeem-stamp-milestone).
  const pointsToRestore = params.stampsConsumed * 10;
  const { data: ptsBal } = await supabaseAdmin
    .from('loyalty_points')
    .select('points')
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId)
    .maybeSingle();
  if (ptsBal) {
    await supabaseAdmin
      .from('loyalty_points')
      .update({ points: Number(ptsBal.points ?? 0) + pointsToRestore, updated_at: new Date().toISOString() })
      .eq('customer_id', params.customerId)
      .eq('merchant_id', params.merchantId);
  }

  await supabaseAdmin.from('loyalty_transactions').insert({
    customer_id: params.customerId,
    merchant_id: params.merchantId,
    order_id: params.orderId,
    type: 'earn',
    loyalty_type: 'stamps',
    points: pointsToRestore,
    description: `Restored ${params.stampsConsumed} stamps from cancelled order ${params.orderId.slice(-8)}`,
    source: 'refund',
  });

  notifyPassUpdate(params.customerId, params.merchantId).catch((err) =>
    console.warn('[Loyalty] notifyPassUpdate failed after stamp refund:', err instanceof Error ? err.message : err),
  );
  return {
    stampsRestored: params.stampsConsumed,
    milestonesCleared: (clearedRows ?? []).map((r) => String((r as { milestone_id: string }).milestone_id)),
    alreadyRestored: false,
  };
}

/** POST /api/loyalty/redeem-cashback — redeem cashback SAR at checkout or via Foodics adapter */
loyaltyRouter.post('/redeem-cashback', async (req, res) => {
  try {
    // Accept either: user auth (app checkout) OR internal secret (Foodics adapter via nooksweb)
    const hasInternalSecret = req.headers['x-nooks-internal-secret'] === (process.env.NOOKS_INTERNAL_SECRET || '').trim();
    if (!hasInternalSecret) {
      const { customerId } = req.body ?? {};
      if (!await requireMatchingCustomer(req, res, customerId)) return;
    }
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { customerId, merchantId, amountSar, orderId } = req.body;
    if (!customerId || !merchantId || !orderId) return res.status(400).json({ error: 'customerId, merchantId, orderId required' });
    const amount = +Number(amountSar).toFixed(2);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    // ─── Idempotency guard (audit Tier 2 #14) ───
    // Reject a second redemption against the same orderId. The atomic
    // balance update further down prevents going negative, but without
    // this guard a customer could chain multiple /redeem-cashback calls
    // during the checkout window — each one debits some cashback for
    // the same single order, draining their balance into one Foodics
    // line that the merchant POS only sees as one discount. With this
    // check, repeat calls return 200 with the original redemption (so
    // a flaky-network retry by the client doesn't 500), and any new
    // attempt is rejected.
    const { data: priorRedeem } = await supabaseAdmin
      .from('loyalty_transactions')
      .select('amount_sar, created_at')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .eq('order_id', orderId)
      .eq('type', 'redeem')
      .eq('loyalty_type', 'cashback')
      .maybeSingle();
    if (priorRedeem) {
      const prevAmount = Math.abs(Number(priorRedeem.amount_sar ?? 0));
      // Same amount = idempotent retry, return success silently.
      // Different amount = real attempt to chain redemption, reject.
      if (Math.abs(prevAmount - amount) <= 0.01) {
        return res.json({ success: true, amountRedeemed: prevAmount, newBalance: null, deduplicated: true });
      }
      return res.status(409).json({
        error: `Order ${orderId} already has a cashback redemption of ${prevAmount} SAR. Cannot stack a second redemption.`,
      });
    }

    // Enforce max cashback per order cap
    const config = await getMerchantConfig(merchantId);
    const maxCap = config.max_cashback_per_order_sar;
    if (maxCap != null && amount > Number(maxCap)) {
      return res.status(400).json({ error: `Maximum cashback per order is ${maxCap} SAR` });
    }

    const { data: balRow } = await supabaseAdmin.from('loyalty_cashback_balances')
      .select('balance_sar, config_version')
      .eq('customer_id', customerId).eq('merchant_id', merchantId)
      .order('config_version', { ascending: false }).limit(1).maybeSingle();

    const balance = balRow?.balance_sar ?? 0;
    if (balance < amount) return res.status(400).json({ error: `Insufficient cashback. Available: ${balance} SAR` });

    // Atomic conditional update: only deduct if balance still >= amount (prevents double-spend race)
    const { data: cbUpdated, error: cbUpdateErr } = await supabaseAdmin.from('loyalty_cashback_balances')
      .update({ balance_sar: +(balance - amount).toFixed(2), updated_at: new Date().toISOString() })
      .eq('customer_id', customerId).eq('merchant_id', merchantId).eq('config_version', balRow!.config_version)
      .gte('balance_sar', amount)
      .select('balance_sar')
      .maybeSingle();
    if (cbUpdateErr || !cbUpdated) {
      return res.status(409).json({ error: 'Redemption failed — balance may have changed. Please try again.' });
    }

    await supabaseAdmin.from('loyalty_transactions').insert({
      customer_id: customerId, merchant_id: merchantId, order_id: orderId,
      type: 'redeem', loyalty_type: 'cashback', amount_sar: -amount,
      points: 0, description: `Used ${amount} SAR cashback`,
      source: 'app', config_version: balRow!.config_version,
    });

    notifyPassUpdate(customerId, merchantId).catch((err) => console.warn('[Loyalty] notifyPassUpdate failed:', err instanceof Error ? err.message : err));
    res.json({ success: true, amountRedeemed: amount, newBalance: +(balance - amount).toFixed(2) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to redeem cashback' });
  }
});

/** GET /api/loyalty/cashback-balance?customerId=X&merchantId=X */
loyaltyRouter.get('/cashback-balance', async (req, res) => {
  try {
    const customerId = req.query.customerId as string;
    const merchantId = req.query.merchantId as string;
    if (!customerId || !merchantId) return res.status(400).json({ error: 'customerId and merchantId required' });
    if (!await requireMatchingCustomer(req, res, customerId)) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data } = await supabaseAdmin.from('loyalty_cashback_balances')
      .select('balance_sar').eq('customer_id', customerId).eq('merchant_id', merchantId)
      .order('config_version', { ascending: false }).limit(1).maybeSingle();

    res.json({ balance: data?.balance_sar ?? 0 });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get cashback balance' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   STAMP MILESTONES — milestone listing + redemption
   ═══════════════════════════════════════════════════════════════════ */

/** GET /api/loyalty/stamp-milestones?merchantId=X */
loyaltyRouter.get('/stamp-milestones', async (req, res) => {
  try {
    const merchantId = req.query.merchantId as string;
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabaseAdmin.from('loyalty_stamp_milestones')
      .select('*').eq('merchant_id', merchantId).eq('is_active', true)
      .order('stamp_number', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ milestones: data ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get milestones' });
  }
});

/** POST /api/loyalty/redeem-stamp-milestone — redeem a stamp milestone reward */
loyaltyRouter.post('/redeem-stamp-milestone', async (req, res) => {
  try {
    // Accept either: user auth (app checkout) OR internal secret (Foodics adapter via nooksweb)
    const hasInternalSecret = req.headers['x-nooks-internal-secret'] === (process.env.NOOKS_INTERNAL_SECRET || '').trim();
    if (!hasInternalSecret) {
      const { customerId: bodyCustomerId } = req.body ?? {};
      if (!await requireMatchingCustomer(req, res, bodyCustomerId)) return;
    }
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { customerId, merchantId, milestoneId, via } = req.body;
    if (!customerId || !merchantId || !milestoneId) {
      return res.status(400).json({ error: 'customerId, merchantId, milestoneId required' });
    }

    // Get milestone
    const { data: milestone } = await supabaseAdmin.from('loyalty_stamp_milestones')
      .select('*').eq('id', milestoneId).eq('merchant_id', merchantId).single();
    if (!milestone) return res.status(404).json({ error: 'Milestone not found' });

    // Idempotency belt-and-suspenders: if we redeemed THIS exact
    // milestone for this customer in the last 30 seconds, treat the
    // call as a no-op replay of a successful prior redemption. The
    // optimistic-concurrency check below ALREADY blocks the actual
    // double-deduct race, but a flaky client that retries on a 200
    // response could otherwise hit "stamps changed during redemption"
    // 409s on the retry path. With this dedupe the retry returns the
    // original success.
    const dedupeWindowMs = 30 * 1000;
    const dedupeSinceIso = new Date(Date.now() - dedupeWindowMs).toISOString();
    const { data: recentRedeem } = await supabaseAdmin
      .from('loyalty_stamp_redemptions')
      .select('id, redeemed_at')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .eq('milestone_id', milestoneId)
      .not('redeemed_at', 'is', null)
      .gte('redeemed_at', dedupeSinceIso)
      .order('redeemed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentRedeem) {
      return res.json({
        success: true,
        idempotent: true,
        rewardName: milestone.reward_name,
        stampsDeducted: 0,
        newStamps: undefined,
      });
    }

    // Atomic stamp deduction with optimistic concurrency. The previous
    // implementation was read-then-update, which let a fast double-tap
    // (or a checkout with multiple selected milestones) deduct from the
    // same balance twice. The .eq('stamps', currentStamps) clause makes
    // the UPDATE a no-op if anything else moved the balance between our
    // read and write — we surface that as 409 so the caller refetches
    // and retries. .select() returns the row(s) actually updated.
    const { data: stampData } = await supabaseAdmin.from('loyalty_stamps')
      .select('stamps').eq('customer_id', customerId).eq('merchant_id', merchantId).maybeSingle();
    const currentStamps = stampData?.stamps ?? 0;
    if (currentStamps < milestone.stamp_number) {
      return res.status(400).json({ error: `Need ${milestone.stamp_number} stamps. Current: ${currentStamps}` });
    }
    const newStampCount = currentStamps - milestone.stamp_number;
    const { data: updatedRows, error: updateError } = await supabaseAdmin.from('loyalty_stamps')
      .update({ stamps: newStampCount, updated_at: new Date().toISOString() })
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .eq('stamps', currentStamps) // optimistic-concurrency guard
      .select('stamps');
    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }
    if (!updatedRows || updatedRows.length === 0) {
      // Either the row didn't exist or another write moved the balance
      // between our read and write — refuse so the client refetches.
      return res.status(409).json({
        error: 'Stamp balance changed during redemption. Refresh and try again.',
      });
    }

    // Mark existing unredeemed record as redeemed, or create new one
    const { data: existingRedemption } = await supabaseAdmin.from('loyalty_stamp_redemptions')
      .select('id')
      .eq('customer_id', customerId).eq('merchant_id', merchantId)
      .eq('milestone_id', milestoneId).is('redeemed_at', null)
      .maybeSingle();

    if (existingRedemption) {
      await supabaseAdmin.from('loyalty_stamp_redemptions')
        .update({ redeemed_at: new Date().toISOString(), redeemed_via: via === 'branch' ? 'branch' : 'app' })
        .eq('id', existingRedemption.id);
    } else {
      await supabaseAdmin.from('loyalty_stamp_redemptions').insert({
        customer_id: customerId, merchant_id: merchantId,
        milestone_id: milestoneId, stamp_number: milestone.stamp_number,
        redeemed_at: new Date().toISOString(),
        redeemed_via: via === 'branch' ? 'branch' : 'app',
      });
    }

    // Deduct internal points (1 stamp = 10 internal points — NOT Foodics points, see earn endpoint comment)
    const pointsToDeduct = milestone.stamp_number * 10;
    const { data: ptsBal } = await supabaseAdmin.from('loyalty_points')
      .select('points').eq('customer_id', customerId).eq('merchant_id', merchantId).maybeSingle();
    if (ptsBal) {
      await supabaseAdmin.from('loyalty_points')
        .update({ points: Math.max(0, ptsBal.points - pointsToDeduct), updated_at: new Date().toISOString() })
        .eq('customer_id', customerId).eq('merchant_id', merchantId);
    }

    // Log transaction
    await supabaseAdmin.from('loyalty_transactions').insert({
      customer_id: customerId, merchant_id: merchantId,
      type: 'redeem', loyalty_type: 'stamps',
      points: -pointsToDeduct,
      description: `Redeemed milestone: ${milestone.reward_name} (-${milestone.stamp_number} stamps)`,
      source: via === 'branch' ? 'branch' : 'app',
    });

    notifyPassUpdate(customerId, merchantId).catch((err) => console.warn('[Loyalty] notifyPassUpdate failed:', err instanceof Error ? err.message : err));
    res.json({ success: true, rewardName: milestone.reward_name, stampsDeducted: milestone.stamp_number, newStamps: newStampCount });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to redeem milestone' });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   LOYALTY PROGRAMS – Versioned program management (DEPRECATED - kept for backwards compat)
   ═══════════════════════════════════════════════════════════════════ */

/** Get the active program ID for a merchant, or null if no programs exist (backwards compat). */
async function getActiveProgramId(merchantId: string): Promise<string | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from('loyalty_programs')
    .select('id')
    .eq('merchant_id', merchantId)
    .eq('status', 'active')
    .maybeSingle();
  return data?.id ?? null;
}

/** GET /api/loyalty/programs?merchantId=X — list all programs for a merchant */
loyaltyRouter.get('/programs', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const merchantId = req.query.merchantId as string;
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });

    const { data, error } = await supabaseAdmin
      .from('loyalty_programs')
      .select('*')
      .eq('merchant_id', merchantId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ programs: data ?? [], activeProgramId: await getActiveProgramId(merchantId) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to list programs' });
  }
});

/** POST /api/loyalty/programs/retire-and-launch — retire current program and launch a new one */
loyaltyRouter.post('/programs/retire-and-launch', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { merchantId, gracePeriodDays = 90, newConfig } = req.body;
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
    if (!newConfig || typeof newConfig !== 'object') return res.status(400).json({ error: 'newConfig required' });

    const graceDays = Math.max(7, Math.min(365, Number(gracePeriodDays) || 90));
    const gracePeriodEnd = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000).toISOString();

    // Find and retire the current active program (if any)
    const currentProgramId = await getActiveProgramId(merchantId);
    if (currentProgramId) {
      const currentConfig = await getMerchantConfig(merchantId);
      await supabaseAdmin
        .from('loyalty_programs')
        .update({
          status: 'retiring',
          grace_period_end: gracePeriodEnd,
          config_snapshot: currentConfig,
        })
        .eq('id', currentProgramId);
    }

    // Create new active program
    const { data: newProgram, error: createErr } = await supabaseAdmin
      .from('loyalty_programs')
      .insert({
        merchant_id: merchantId,
        status: 'active',
        config_snapshot: newConfig,
      })
      .select('id')
      .single();

    if (createErr) return res.status(500).json({ error: createErr.message });

    // Update loyalty_config with new settings.
    // stamp_target intentionally NOT in allowedFields — platform-locked at 8.
    const configPayload: Record<string, unknown> = { merchant_id: merchantId };
    const allowedFields = [
      'earn_mode', 'points_per_sar', 'points_per_order', 'point_value_sar',
      'expiry_months', 'stamp_enabled', 'stamp_reward_description',
      'wallet_card_bg_color', 'wallet_card_text_color', 'wallet_card_logo_url',
      'wallet_card_label', 'wallet_card_secondary_label', 'pass_template_type',
    ];
    for (const key of allowedFields) {
      if (key in newConfig) configPayload[key] = newConfig[key];
    }

    await supabaseAdmin
      .from('loyalty_config')
      .upsert(configPayload, { onConflict: 'merchant_id' });

    res.json({
      success: true,
      retiredProgramId: currentProgramId,
      newProgramId: newProgram.id,
      gracePeriodEnd,
      gracePeriodDays: graceDays,
    });
  } catch (err: any) {
    console.error('[Loyalty] Retire & Launch error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to retire and launch program' });
  }
});
