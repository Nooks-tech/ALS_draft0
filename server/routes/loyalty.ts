/**
 * Loyalty routes – merchant-config-driven points, stamps, rewards, and wallet pass
 */
import { createClient } from '@supabase/supabase-js';
import { Router, type Request, type Response } from 'express';
import { notifyPassUpdate } from './walletPass';
import { ensureLoyaltyMemberProfile, findLoyaltyMemberByLookup } from '../services/loyaltyMembers';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';
import { requireDiagnosticAccess, requireNooksInternalRequest } from '../utils/nooksInternal';

export const loyaltyRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const DEFAULT_CONFIG = {
  loyalty_type: 'points' as 'cashback' | 'points' | 'stamps',
  earn_mode: 'per_sar' as const,
  points_per_sar: 0.1,
  points_per_order: 10,
  point_value_sar: 0.1,
  cashback_percent: 5,
  expiry_months: null as number | null,
  stamp_enabled: false,
  stamp_target: 10,
  stamp_reward_description: 'Free item',
  wallet_card_logo_scale: null as number | null,
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

/**
 * Determines which loyalty system a customer should earn on and redeem from,
 * handling the transition period when a merchant switches loyalty types.
 *
 * Rules:
 * - If no previous type (config_version=1 or previous_loyalty_type is null): current type for both
 * - New users (no earn transactions before the switch): current type immediately
 * - Old users with balance > 0 on old system: earn on NEW (hidden), redeem on OLD only
 * - Old users with balance = 0 (spent/expired): fully on new system
 */
async function getCustomerLoyaltyRoute(merchantId: string, customerId: string) {
  const config = await getMerchantConfig(merchantId);
  const currentType = config.loyalty_type ?? 'points';
  const previousType = (config as any).previous_loyalty_type as string | null;
  const configVersion = config.config_version ?? 1;
  const configChangedAt = (config as any).config_changed_at as string | null;

  const noTransition = { earn: currentType, redeem: currentType, transitioning: false, oldSystemType: null as string | null, oldBalance: 0 };

  // No previous type means no switch ever happened
  if (!previousType || configVersion <= 1 || !configChangedAt) {
    return noTransition;
  }

  if (!supabaseAdmin) return noTransition;

  // Check if we already have a transition record for this customer at this config version
  const { data: existingTransition } = await supabaseAdmin
    .from('loyalty_customer_transitions')
    .select('*')
    .eq('customer_id', customerId)
    .eq('merchant_id', merchantId)
    .eq('config_version_at_switch', configVersion)
    .maybeSingle();

  if (existingTransition?.old_balance_exhausted) {
    return noTransition; // Already fully transitioned
  }

  // Check if customer had any earn transactions BEFORE the switch
  const { count: priorTxCount } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', customerId)
    .eq('merchant_id', merchantId)
    .eq('type', 'earn')
    .lt('created_at', configChangedAt);

  if (!priorTxCount || priorTxCount === 0) {
    // New user — never interacted before switch, go straight to new system
    if (!existingTransition) {
      await supabaseAdmin.from('loyalty_customer_transitions').upsert({
        customer_id: customerId,
        merchant_id: merchantId,
        from_loyalty_type: previousType,
        to_loyalty_type: currentType,
        config_version_at_switch: configVersion,
        old_balance_exhausted: true,
        old_balance_exhausted_at: new Date().toISOString(),
      }, { onConflict: 'customer_id,merchant_id,config_version_at_switch' });
    }
    return noTransition;
  }

  // Old user — check their balance on the OLD system
  let oldBalance = 0;
  if (previousType === 'cashback') {
    const { data: cb } = await supabaseAdmin.from('loyalty_cashback_balances')
      .select('balance_sar')
      .eq('customer_id', customerId).eq('merchant_id', merchantId)
      .order('config_version', { ascending: false }).limit(1).maybeSingle();
    oldBalance = cb?.balance_sar ?? 0;
  } else if (previousType === 'points') {
    const { data: pts } = await supabaseAdmin.from('loyalty_points')
      .select('points')
      .eq('customer_id', customerId).eq('merchant_id', merchantId)
      .order('config_version', { ascending: false }).limit(1).maybeSingle();
    oldBalance = (pts?.points ?? 0) * (config.point_value_sar ?? 0.1);
  } else if (previousType === 'stamps') {
    const { data: st } = await supabaseAdmin.from('loyalty_stamps')
      .select('stamps')
      .eq('customer_id', customerId).eq('merchant_id', merchantId).maybeSingle();
    oldBalance = st?.stamps ?? 0; // stamps count, not SAR
  }

  // Create or check transition record
  if (!existingTransition) {
    const exhausted = oldBalance <= 0;
    await supabaseAdmin.from('loyalty_customer_transitions').upsert({
      customer_id: customerId,
      merchant_id: merchantId,
      from_loyalty_type: previousType,
      to_loyalty_type: currentType,
      config_version_at_switch: configVersion,
      old_balance_exhausted: exhausted,
      ...(exhausted ? { old_balance_exhausted_at: new Date().toISOString() } : {}),
    }, { onConflict: 'customer_id,merchant_id,config_version_at_switch' });

    if (exhausted) return noTransition;
  }

  // Balance > 0: still transitioning
  if (oldBalance <= 0) {
    // Balance drained since last check — mark exhausted
    await supabaseAdmin.from('loyalty_customer_transitions')
      .update({ old_balance_exhausted: true, old_balance_exhausted_at: new Date().toISOString() })
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .eq('config_version_at_switch', configVersion);
    return noTransition;
  }

  return {
    earn: currentType,
    redeem: previousType,
    transitioning: true,
    oldSystemType: previousType,
    oldBalance,
  };
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

  notifyPassUpdate(params.customerId, params.merchantId).catch(() => {});
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

  await supabaseAdmin
    .from('loyalty_points')
    .update({ points: balance.points - reward.points_cost, updated_at: new Date().toISOString() })
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId);

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

  notifyPassUpdate(params.customerId, params.merchantId).catch(() => {});
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

    const allowed = [
      'loyalty_type', 'earn_mode', 'points_per_sar', 'points_per_order', 'point_value_sar',
      'cashback_percent',
      'expiry_months', 'stamp_enabled', 'stamp_target', 'stamp_reward_description',
      'wallet_card_bg_color', 'wallet_card_text_color', 'wallet_card_logo_url',
      'wallet_card_label', 'wallet_card_secondary_label', 'wallet_card_logo_scale',
      'wallet_card_banner_url', 'wallet_stamp_box_color', 'wallet_stamp_icon_color',
      'wallet_stamp_icon_url', 'business_type', 'pass_template_type',
    ];

    // Config versioning: if loyalty_type or key rates changed, bump version
    const currentConfig = await getMerchantConfig(merchantId);
    const typeChanged = fields.loyalty_type && fields.loyalty_type !== currentConfig.loyalty_type;
    const rateChanged = (fields.cashback_percent != null && fields.cashback_percent !== currentConfig.cashback_percent)
      || (fields.points_per_sar != null && fields.points_per_sar !== currentConfig.points_per_sar)
      || (fields.point_value_sar != null && fields.point_value_sar !== currentConfig.point_value_sar);
    if (typeChanged || rateChanged) {
      fields.config_version = (currentConfig.config_version ?? 1) + 1;
      fields.previous_loyalty_type = currentConfig.loyalty_type ?? 'points';
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

    const loyaltyType = config.loyalty_type ?? 'points';

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

    // Check if this customer is in a loyalty program transition
    const route = await getCustomerLoyaltyRoute(merchantId, customerId);

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

    // Branch by loyalty type
    const config = await getMerchantConfig(merchantId || '');
    const loyaltyType = config.loyalty_type ?? 'points';

    if (loyaltyType === 'cashback') {
      await ensureLoyaltyMemberProfile(merchantId || '', customerId);
      const result = await earnCashback(merchantId || '', customerId, orderId, Number(orderSubtotal));
      return res.json(result);
    }

    if (loyaltyType === 'stamps') {
      await ensureLoyaltyMemberProfile(merchantId || '', customerId);
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
        ? new Date(Date.now() + config.expiry_months * 30 * 24 * 60 * 60 * 1000).toISOString()
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

        // Push notification to customer
        try {
          const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;
          const { data: subs } = await supabaseAdmin.from('push_subscriptions')
            .select('expo_push_token').eq('user_id', customerId);
          const tokens = (subs ?? []).map((s: any) => s.expo_push_token).filter(Boolean);
          if (tokens.length > 0) {
            const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
            if (EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${EXPO_ACCESS_TOKEN}`;
            await fetch('https://exp.host/--/api/v2/push/send', {
              method: 'POST', headers,
              body: JSON.stringify(tokens.map((t: string) => ({
                to: t, sound: 'default',
                title: 'Milestone Reward Unlocked!',
                body: `You earned ${hit.stamp_number} stamps! Your reward: ${hit.reward_name}. Show your wallet card at the branch or redeem in the app.`,
                channelId: 'loyalty',
              }))),
            });
          }
        } catch { /* best-effort push */ }
      }

      notifyPassUpdate(customerId, merchantId || '').catch(() => {});
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
    ? new Date(Date.now() + config.expiry_months * 30 * 24 * 60 * 60 * 1000).toISOString()
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

  notifyPassUpdate(customerId, merchantId).catch(() => {});

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
    if (!await requireMatchingCustomer(req, res, customerId)) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    let query = supabaseAdmin
      .from('loyalty_transactions')
      .select('*')
      .eq('customer_id', customerId);
    if (merchantId) query = query.eq('merchant_id', merchantId);
    const { data, error } = await query
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
    ? new Date(Date.now() + config.expiry_months * 30 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  await supabaseAdmin.from('loyalty_transactions').insert({
    customer_id: customerId, merchant_id: merchantId, order_id: orderId,
    type: 'earn', loyalty_type: 'cashback', amount_sar: cashbackSar,
    points: 0, description: `Earned ${cashbackSar} SAR cashback`,
    source: 'app', expires_at: expiresAt, config_version: currentVersion,
  });

  notifyPassUpdate(customerId, merchantId).catch(() => {});
  return { success: true, cashbackEarned: cashbackSar, newBalance: +((balRow?.balance_sar ?? 0) + cashbackSar).toFixed(2) };
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

    await supabaseAdmin.from('loyalty_cashback_balances')
      .update({ balance_sar: +(balance - amount).toFixed(2), updated_at: new Date().toISOString() })
      .eq('customer_id', customerId).eq('merchant_id', merchantId).eq('config_version', balRow!.config_version);

    await supabaseAdmin.from('loyalty_transactions').insert({
      customer_id: customerId, merchant_id: merchantId, order_id: orderId,
      type: 'redeem', loyalty_type: 'cashback', amount_sar: -amount,
      points: 0, description: `Used ${amount} SAR cashback`,
      source: 'app', config_version: balRow!.config_version,
    });

    notifyPassUpdate(customerId, merchantId).catch(() => {});
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
    if (!requireNooksInternalRequest(req, res)) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { customerId, merchantId, milestoneId, via } = req.body;
    if (!customerId || !merchantId || !milestoneId) {
      return res.status(400).json({ error: 'customerId, merchantId, milestoneId required' });
    }

    // Get milestone
    const { data: milestone } = await supabaseAdmin.from('loyalty_stamp_milestones')
      .select('*').eq('id', milestoneId).eq('merchant_id', merchantId).single();
    if (!milestone) return res.status(404).json({ error: 'Milestone not found' });

    // Check stamps
    const { data: stampData } = await supabaseAdmin.from('loyalty_stamps')
      .select('stamps').eq('customer_id', customerId).eq('merchant_id', merchantId).maybeSingle();
    const currentStamps = stampData?.stamps ?? 0;
    if (currentStamps < milestone.stamp_number) {
      return res.status(400).json({ error: `Need ${milestone.stamp_number} stamps. Current: ${currentStamps}` });
    }

    // Deduct milestone stamps (not reset to 0)
    const newStampCount = Math.max(0, currentStamps - milestone.stamp_number);
    await supabaseAdmin.from('loyalty_stamps')
      .update({ stamps: newStampCount, updated_at: new Date().toISOString() })
      .eq('customer_id', customerId).eq('merchant_id', merchantId);

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

    notifyPassUpdate(customerId, merchantId).catch(() => {});
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

    // Update loyalty_config with new settings
    const configPayload: Record<string, unknown> = { merchant_id: merchantId };
    const allowedFields = [
      'earn_mode', 'points_per_sar', 'points_per_order', 'point_value_sar',
      'expiry_months', 'stamp_enabled', 'stamp_target', 'stamp_reward_description',
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
