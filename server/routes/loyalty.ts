/**
 * Loyalty routes – merchant-config-driven points + cashback rewards, and wallet pass.
 *
 * Phase 1 refactor (2026-05-26): stamps mode dropped. The remaining
 * loyalty modes are 'points' (default) and 'cashback'. Milestone
 * rewards now live on the renamed loyalty_milestones table and use
 * a points_threshold column instead of stamp_number. Phase 2/3 will
 * rebuild the wallet-pass + customer-app loyalty UI around the new
 * points model.
 */
import { createClient } from '@supabase/supabase-js';
import { Router, type Request, type Response } from 'express';
import { notifyPassUpdateSafe } from './walletPass';
import { ensureLoyaltyMemberProfile, findLoyaltyMemberByLookup } from '../services/loyaltyMembers';
import { requireAuthenticatedAppUser, requireVerifiedAtMerchant } from '../utils/appUserAuth';
import { hasValidInternalSecret, requireDiagnosticAccess, requireNooksInternalRequest } from '../utils/nooksInternal';
import { enforceLimits } from '../utils/rateLimit';

export const loyaltyRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

type LoyaltyMode = 'cashback' | 'points';

const DEFAULT_CONFIG = {
  loyalty_type: null as LoyaltyMode | null,
  earn_mode: 'per_sar' as const,
  points_per_sar: 0.1,
  points_per_order: 10,
  point_value_sar: 0.1,
  cashback_percent: 5,
  expiry_months: null as number | null,
  wallet_card_logo_scale: null as number | null,
  wallet_stamp_icon_scale: null as number | null,
  config_version: 1,
};

// 30s TTL cache — the earn path used to read loyalty_config twice per earn
// (route handler + earnPoints/earnCashback), each a ~250ms Railway→Tokyo
// round-trip inside the Foodics webhook's 3.5s budget. Config writes in
// this file invalidate explicitly; dashboard-side writes are covered by
// the TTL.
const MERCHANT_CONFIG_TTL_MS = 30_000;
const merchantConfigCache = new Map<string, { at: number; value: any }>();

function invalidateMerchantConfigCache(merchantId: string) {
  merchantConfigCache.delete(merchantId);
}

async function getMerchantConfig(merchantId: string) {
  if (!supabaseAdmin || !merchantId) return DEFAULT_CONFIG;
  const cached = merchantConfigCache.get(merchantId);
  if (cached && Date.now() - cached.at < MERCHANT_CONFIG_TTL_MS) return cached.value;
  const { data, error } = await supabaseAdmin
    .from('loyalty_config')
    .select('*')
    .eq('merchant_id', merchantId)
    .maybeSingle();
  if (error) {
    console.warn('[loyalty] getMerchantConfig error for', merchantId, ':', error.message);
    // Don't cache transient failures — next call retries the DB.
    return DEFAULT_CONFIG;
  }
  const value = data ?? DEFAULT_CONFIG;
  merchantConfigCache.set(merchantId, { at: Date.now(), value });
  if (merchantConfigCache.size > 2000) {
    const cutoff = Date.now() - MERCHANT_CONFIG_TTL_MS;
    for (const [k, v] of merchantConfigCache) {
      if (v.at < cutoff) merchantConfigCache.delete(k);
    }
  }
  return value;
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
      // points (or legacy stamps row, which now lives only in
      // loyalty_points after the Phase 1 schema collapse)
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

    // Zero out the DESTINATION system's balance so a customer who
    // accumulated in X, was switched to Y and exhausted Y, then
    // flipped back to X doesn't see old X balance resurface.
    if (merchantType === 'points') {
      await supabaseAdmin.from('loyalty_points')
        .update({ points: 0, updated_at: now })
        .eq('customer_id', customerId).eq('merchant_id', merchantId);
    } else if (merchantType === 'cashback') {
      await supabaseAdmin.from('loyalty_cashback_balances')
        .update({ balance_sar: 0, updated_at: now })
        .eq('customer_id', customerId).eq('merchant_id', merchantId);
    }

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
    notifyPassUpdateSafe(customerId, merchantId);
    console.log(`[loyalty] Auto-switched customer ${customerId.substring(0, 8)}… from ${customerType} to ${merchantType} (0 balance) — destination balance reset`);
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
  // Phase H8: Foodics order uuid bridging the app earn (keyed on
  // customer_orders.id) and the branch/kiosk earn (keyed on
  // branch-sale:<foodics-order-uuid>) for the same physical purchase.
  foodicsOrderRef?: string | null;
  metadata?: Record<string, unknown>;
};

// ── Phase H8: cross-channel double-earn guard (app ↔ branch) ──
// One physical purchase can earn twice because the two channels key
// idempotency on different ids. Rollout is gated by
// CROSS_CHANNEL_EARN_GUARD: 'off' = no behavior change, no logging;
// 'shadow' (default) = log the dedup decision only — earns EXACTLY as
// today and never writes foodics_order_ref (the partial unique index
// idx_loyalty_foodics_purchase_earn_unique stays dormant/empty);
// 'enforce' = skip/redirect duplicates AND stamp foodics_order_ref on
// earn inserts so the unique index is the atomic backstop.
type CrossChannelGuardMode = 'off' | 'shadow' | 'enforce';
function crossChannelGuardMode(): CrossChannelGuardMode {
  const raw = (process.env.CROSS_CHANNEL_EARN_GUARD ?? '').trim();
  return raw === 'off' || raw === 'enforce' ? raw : 'shadow';
}

const FOODICS_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the Foodics order uuid for an earn and detect a prior earn from
 * the OTHER channel (branch) for the same physical purchase. Shared by
 * earnPoints and earnCashback. Returns the resolved ref (null when the
 * guard is off or no ref exists) and whether a prior branch earn exists.
 * Deliberately does NOT filter the prior-earn lookup by customer_id — a
 * pre-merge identity split can put the branch earn on a different
 * customer row for the same person.
 */
async function resolveCrossChannelEarnGuard(params: {
  mode: CrossChannelGuardMode;
  merchantId: string;
  orderId: string;
  contextRef?: string | null;
}): Promise<{ foodicsRef: string | null; priorBranchEarn: boolean }> {
  if (params.mode === 'off' || !supabaseAdmin) return { foodicsRef: null, priorBranchEarn: false };
  let foodicsRef = normalizeOptionalString(params.contextRef);
  if (!foodicsRef) {
    const { data: orderRow } = await supabaseAdmin
      .from('customer_orders')
      .select('foodics_order_id')
      .eq('id', params.orderId)
      .eq('merchant_id', params.merchantId)
      .maybeSingle();
    foodicsRef = normalizeOptionalString(orderRow?.foodics_order_id);
  }
  if (!foodicsRef) return { foodicsRef: null, priorBranchEarn: false };
  const { data: branchEarn } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id')
    .eq('merchant_id', params.merchantId)
    .eq('type', 'earn')
    .eq('source', 'branch')
    .eq('reference_id', foodicsRef)
    .limit(1)
    .maybeSingle();
  return { foodicsRef, priorBranchEarn: Boolean(branchEarn) };
}

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

  notifyPassUpdateSafe(params.customerId, params.merchantId);
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

  notifyPassUpdateSafe(params.customerId, params.merchantId);
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

    // Phase 1: stamps mode dropped. loyalty_type accepts 'points' or
    // 'cashback' only. Legacy stamp_* columns are no longer writable.
    const allowed = [
      'loyalty_type', 'earn_mode', 'points_per_sar', 'points_per_order', 'point_value_sar',
      'cashback_percent',
      'expiry_months',
      'wallet_card_bg_color', 'wallet_card_text_color', 'wallet_card_logo_url',
      'wallet_card_label', 'wallet_card_secondary_label', 'wallet_card_logo_scale',
      'wallet_card_banner_url', 'wallet_stamp_box_color', 'wallet_stamp_icon_color',
      'wallet_stamp_icon_url', 'wallet_stamp_icon_scale', 'business_type', 'pass_template_type',
    ];
    if (fields.loyalty_type && fields.loyalty_type !== 'points' && fields.loyalty_type !== 'cashback') {
      return res.status(400).json({ error: "loyalty_type must be 'points' or 'cashback'" });
    }

    // Config versioning: if loyalty_type or key rates changed, bump version
    const currentConfig = await getMerchantConfig(merchantId);
    const typeChanged = fields.loyalty_type && fields.loyalty_type !== currentConfig.loyalty_type;
    const rateChanged = (fields.cashback_percent != null && fields.cashback_percent !== currentConfig.cashback_percent)
      || (fields.points_per_sar != null && fields.points_per_sar !== currentConfig.points_per_sar)
      || (fields.point_value_sar != null && fields.point_value_sar !== currentConfig.point_value_sar);
    const previousConfigVersion = currentConfig.config_version ?? 1;
    let bumpedToVersion: number | null = null;
    if (typeChanged || rateChanged) {
      fields.config_version = previousConfigVersion + 1;
      fields.previous_loyalty_type = currentConfig.loyalty_type ?? 'points';
      fields.config_changed_at = new Date().toISOString();
      allowed.push('config_version', 'previous_loyalty_type', 'config_changed_at');
      bumpedToVersion = fields.config_version;
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
    invalidateMerchantConfigCache(merchantId);

    // Cashback balance migration on config_version bump. When
    // loyalty_type or rates change we bump config_version so the
    // transaction audit trail can distinguish earns under the old
    // vs new rules. Without a matching balance-row migration the
    // bump leaves every customer's balance row stuck at the
    // previous version, so reads (which look up the latest row
    // via .order('config_version', { ascending: false }).limit(1))
    // keep returning the v1 row even when the merchant has long
    // since moved to v2. That's mostly harmless but it makes
    // reconciliation against transactions noisy and would break
    // any future code that filters strictly on currentVersion.
    //
    // We copy (not move) non-zero balances forward so the v1 row
    // survives as a historical record. `ignoreDuplicates: true`
    // makes this safe to retry — if a v2 row was already created
    // by a concurrent earn (theoretically possible if a customer
    // earned in the window between this endpoint's currentConfig
    // SELECT and the migration write), the existing v2 balance
    // wins instead of being clobbered by the older v1 amount.
    if (bumpedToVersion !== null) {
      const { data: oldBalances, error: balErr } = await supabaseAdmin
        .from('loyalty_cashback_balances')
        .select('customer_id, balance_sar')
        .eq('merchant_id', merchantId)
        .eq('config_version', previousConfigVersion)
        .gt('balance_sar', 0);
      if (balErr) {
        console.warn('[loyalty] cashback balance migration query failed:', balErr.message);
      } else if (oldBalances && oldBalances.length > 0) {
        const now = new Date().toISOString();
        const newRows = oldBalances.map((row) => ({
          customer_id: row.customer_id,
          merchant_id: merchantId,
          config_version: bumpedToVersion,
          balance_sar: row.balance_sar,
          updated_at: now,
        }));
        const { error: migErr } = await supabaseAdmin
          .from('loyalty_cashback_balances')
          .upsert(newRows, {
            onConflict: 'customer_id,merchant_id,config_version',
            ignoreDuplicates: true,
          });
        if (migErr) {
          console.warn('[loyalty] cashback balance migration upsert failed:', migErr.message);
        } else {
          console.log(`[loyalty] migrated ${newRows.length} cashback balances from v${previousConfigVersion} to v${bumpedToVersion} for merchant ${merchantId}`);
        }
      }
    }

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
    const loyaltyType = (route.redeem as LoyaltyMode | null) ?? config.loyalty_type ?? 'points';

    // Milestones — the renamed loyalty_milestones table now uses
    // points_threshold instead of stamp_number. Phase 3 surfaces both
    // the new canonical field (points_threshold + reward_image_url +
    // reward_description) AND the legacy stamp_number alias so older
    // builds of the app keep compiling. The new winding-path UI only
    // reads the canonical names.
    let stampMilestones: Array<{
      id: string;
      stamp_number: number;
      points_threshold: number;
      reward_name: string;
      reward_description: string | null;
      reward_image_url: string | null;
      foodics_product_ids: string[];
    }> = [];
    if (loyaltyType === 'points') {
      const { data: milestoneData } = await supabaseAdmin
        .from('loyalty_milestones')
        .select('id, points_threshold, reward_name, reward_description, reward_image_url, foodics_product_ids')
        .eq('merchant_id', merchantId)
        .eq('is_active', true)
        .order('points_threshold', { ascending: true });

      // Pull Foodics product images for every product referenced by
      // these milestones in one query — we no longer rely on the
      // dashboard image-upload column. The merchant manages product
      // photos in Foodics, full stop. If a Foodics image is missing
      // we fall back to the stored reward_image_url for back-compat.
      const allProductIds = Array.from(
        new Set(
          (milestoneData ?? [])
            .flatMap((m: { foodics_product_ids?: string[] | null }) => m.foodics_product_ids ?? [])
            .filter((id: string) => typeof id === 'string' && id),
        ),
      );
      // Table is `products`; the Foodics product UUID is stored on
      // `foodics_product_id` (the row's own `id` is our internal PK).
      // Scope by merchant_id to keep RLS-safe even though service-role
      // can read across — defensive against future RLS tightening.
      const productImages = new Map<string, string>();
      if (allProductIds.length > 0) {
        const { data: prodData } = await supabaseAdmin
          .from('products')
          .select('foodics_product_id, image_url')
          .eq('merchant_id', merchantId)
          .in('foodics_product_id', allProductIds);
        for (const p of (prodData ?? []) as Array<{ foodics_product_id: string; image_url: string | null }>) {
          if (p.image_url) productImages.set(p.foodics_product_id, p.image_url);
        }
      }

      stampMilestones = (milestoneData ?? []).map((m: {
        id: string;
        points_threshold: number;
        reward_name: string;
        reward_description: string | null;
        reward_image_url: string | null;
        foodics_product_ids: string[] | null;
      }) => {
        const firstProductId = m.foodics_product_ids?.[0];
        const foodicsImage = firstProductId ? productImages.get(firstProductId) ?? null : null;
        return {
          id: m.id,
          stamp_number: m.points_threshold,
          points_threshold: m.points_threshold,
          reward_name: m.reward_name,
          reward_description: m.reward_description,
          // Foodics product image is authoritative; reward_image_url
          // is legacy fallback for milestones created before this fix.
          reward_image_url: foodicsImage ?? m.reward_image_url,
          foodics_product_ids: m.foodics_product_ids ?? [],
        };
      });
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
      // Legacy stamp-shaped fields — kept for mobile UI compatibility
      // during the Phase 1 cut-over. Phase 3 will remove these from the
      // response and the consuming UI together.
      stampEnabled: loyaltyType === 'points',
      stampTarget: 8,
      stampRewardDescription: '',
      stamps: 0,
      completedCards: 0,
      stampMilestones,
      availableRedemptions: [] as Array<{ id: string; milestone_id: string; stamp_number: number }>,
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
): Promise<{ success: boolean; pointsEarned: number; newBalance: number }> {
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
    };
  }

  // Phase H8: cross-channel dedup — has the OTHER channel (branch/kiosk)
  // already earned for this physical purchase? See crossChannelGuardMode.
  const guardMode = crossChannelGuardMode();
  const { foodicsRef, priorBranchEarn } = await resolveCrossChannelEarnGuard({
    mode: guardMode,
    merchantId,
    orderId,
    contextRef: context?.foodicsOrderRef,
  });
  if (priorBranchEarn) {
    if (guardMode === 'enforce') {
      let balQuery = supabaseAdmin
        .from('loyalty_points')
        .select('points')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId);
      if (programId) balQuery = balQuery.eq('program_id', programId);
      const { data: bal } = await balQuery.maybeSingle();
      return { success: true, pointsEarned: 0, newBalance: bal?.points ?? 0 };
    }
    console.log('[cross-channel-dedup] would_skip', { merchantId, foodicsRef, orderId });
  }

  const config = await getMerchantConfig(merchantId);

  const pointsEarned = config.earn_mode === 'per_order'
    ? Math.floor(config.points_per_order)
    : Math.floor(orderSubtotal * config.points_per_sar);

  const expiresAt = config.expiry_months
    ? (() => { const d = new Date(); d.setMonth(d.getMonth() + config.expiry_months!); return d.toISOString(); })()
    : null;

  // Insert the ledger row FIRST so the partial unique index
  // idx_loyalty_transactions_app_earn_unique arbitrates the double-earn
  // race (e.g. Foodics firing the order webhook twice — the cashback
  // incident on 2026-05-15). The race-loser's INSERT fails with 23505 and
  // we short-circuit WITHOUT calling the increment RPC, so the balance is
  // credited exactly once. (The SELECT idempotency check above is a fast
  // path for the common already-earned case; this is the atomic backstop.)
  const ledger = await supabaseAdmin
    .from('loyalty_transactions')
    .insert({
      customer_id: customerId,
      merchant_id: merchantId,
      order_id: orderId,
      type: 'earn',
      loyalty_type: 'points',
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
      // Phase H8: stamped ONLY in enforce mode — in off/shadow the column
      // stays null so idx_loyalty_foodics_purchase_earn_unique stays dormant.
      ...(guardMode === 'enforce' && foodicsRef ? { foodics_order_ref: foodicsRef } : {}),
    })
    .select('id')
    .maybeSingle();
  if (ledger.error) {
    if ((ledger.error as { code?: string }).code === '23505') {
      // Race-loser / retry — already earned for this order. Return the
      // current balance without crediting again.
      let balQuery = supabaseAdmin
        .from('loyalty_points')
        .select('points')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId);
      if (programId) balQuery = balQuery.eq('program_id', programId);
      const { data: bal } = await balQuery.maybeSingle();
      return { success: true, pointsEarned: 0, newBalance: bal?.points ?? 0 };
    }
    throw new Error(ledger.error.message);
  }

  // Won the slot — credit the balance atomically via the SECURITY DEFINER
  // RPC (INSERT…ON CONFLICT; immune to the RLS read-then-update edge case).
  const { data: incData, error: incErr } = await supabaseAdmin.rpc('increment_loyalty_points', {
    p_customer_id: customerId,
    p_merchant_id: merchantId,
    p_points: pointsEarned,
    p_config_version: config?.config_version ?? 1,
  });
  if (incErr) {
    // Roll back the ledger row so a retry can re-earn (no split-brain).
    if (ledger.data?.id) {
      await supabaseAdmin.from('loyalty_transactions').delete().eq('id', ledger.data.id);
    }
    console.error('[earnPoints] increment_loyalty_points RPC failed:', incErr.message);
    throw new Error(`Loyalty points increment failed: ${incErr.message}`);
  }
  const rpcNewBalance =
    Array.isArray(incData) && incData[0] && typeof (incData[0] as { points?: unknown }).points === 'number'
      ? (incData[0] as { points: number }).points
      : null;

  notifyPassUpdateSafe(customerId, merchantId);

  return {
    success: true,
    pointsEarned,
    // The RPC returns the authoritative post-credit balance.
    newBalance: rpcNewBalance ?? pointsEarned,
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
    // constant-time compare via shared helper — the previous inline
    // === check was a microsecond-level timing oracle.
    const hasInternalSecret = hasValidInternalSecret(req);
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

    // R6 fix: require merchantId in the body and scope the update by
    // (id, merchant_id). Pre-fix, the query was `.eq('id', ...)` only —
    // a leaked internal-secret holder could enumerate reward UUIDs
    // and modify any merchant's rewards. The merchant_id filter
    // ensures even a leaked secret can only touch rewards for the
    // merchant the caller explicitly named.
    const { name, description, image_url, points_cost, is_active, merchantId } = req.body;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });
    if (!merchantId || typeof merchantId !== 'string') {
      return res.status(400).json({ error: 'merchantId is required' });
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (image_url !== undefined) updates.image_url = image_url;
    if (points_cost !== undefined) updates.points_cost = Number(points_cost);
    if (is_active !== undefined) updates.is_active = is_active;

    const { data: updated, error } = await supabaseAdmin
      .from('loyalty_rewards')
      .update(updates)
      .eq('id', req.params.id)
      .eq('merchant_id', merchantId)
      .select('id')
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!updated) {
      return res.status(404).json({
        error: 'Reward not found for the given merchant',
        code: 'REWARD_NOT_FOUND',
      });
    }
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
    // R6 fix: same merchant-id scoping as PUT. DELETE is a soft-delete
    // (sets is_active=false) so we still require merchantId in body.
    const merchantId = typeof req.body?.merchantId === 'string'
      ? req.body.merchantId
      : typeof req.query.merchantId === 'string'
        ? req.query.merchantId
        : '';
    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId is required' });
    }
    const { data: updated, error } = await supabaseAdmin
      .from('loyalty_rewards')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .eq('merchant_id', merchantId)
      .select('id')
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!updated) {
      return res.status(404).json({
        error: 'Reward not found for the given merchant',
        code: 'REWARD_NOT_FOUND',
      });
    }
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

    // ── Phase H8: cross-channel double-earn guard (walk-in capture) ──
    // Kiosk poll-sync passes the Foodics order uuid as referenceId. When
    // that Foodics order was actually placed through the app
    // (customer_orders has a matching foodics_order_id), the app lifecycle
    // owns the earn — earning here too would double-earn one purchase.
    const guardMode = crossChannelGuardMode();
    const isFoodicsUuidRef = FOODICS_UUID_RE.test(referenceId);
    let redirectTo: { id: string; customer_id: string } | null = null;
    if (guardMode !== 'off' && isFoodicsUuidRef && supabaseAdmin) {
      const { data: appOrder } = await supabaseAdmin
        .from('customer_orders')
        .select('id, customer_id, status')
        .eq('merchant_id', merchantId)
        .eq('foodics_order_id', referenceId)
        .maybeSingle();
      if (appOrder) {
        if (appOrder.status === 'Cancelled') {
          if (guardMode === 'enforce') {
            return res.status(409).json({ error: 'Cannot earn loyalty on a cancelled app order' });
          }
          console.log('[cross-channel-dedup] would_skip', { merchantId, foodicsRef: referenceId, orderId: appOrder.id });
        } else if (appOrder.status === 'Delivered') {
          // Delivered — the app earn (if any) is keyed on the app order id.
          // Redirect this branch earn onto the same order id + customer so
          // the order-level idempotency in earnPoints plus the foodics
          // unique index dedup the two channels atomically.
          if (guardMode === 'enforce' && appOrder.customer_id) {
            redirectTo = { id: String(appOrder.id), customer_id: String(appOrder.customer_id) };
          } else if (guardMode !== 'enforce') {
            console.log('[cross-channel-dedup] would_redirect', { merchantId, foodicsRef: referenceId, orderId: appOrder.id });
          }
        } else {
          // App order exists but is still mid-lifecycle — it earns when it
          // reaches Delivered; earning here now would double it then.
          if (guardMode === 'enforce') {
            return res.json({ success: true, pointsEarned: 0, skipped: 'app_order_owns_earn' });
          }
          console.log('[cross-channel-dedup] would_skip', { merchantId, foodicsRef: referenceId, orderId: appOrder.id });
        }
      }
    }

    const orderId = redirectTo ? redirectTo.id : buildBranchReference('branch-sale', referenceId);
    const result = await earnPoints(redirectTo ? redirectTo.customer_id : member.customer_id, orderId, amountSar, merchantId, {
      source: 'branch',
      branchId,
      actorUserId,
      actorRole,
      referenceType: 'branch_sale',
      referenceId,
      // Phase H8: only forwarded in enforce mode (and earnPoints only
      // writes foodics_order_ref in enforce) so shadow stays non-mutating.
      ...(guardMode === 'enforce' && isFoodicsUuidRef ? { foodicsOrderRef: referenceId } : {}),
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
async function earnCashback(merchantId: string, customerId: string, orderId: string, orderSubtotal: number, context?: LoyaltyActionContext) {
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

  // Phase H8: cross-channel dedup — has the branch/kiosk channel already
  // earned for this physical purchase? See crossChannelGuardMode.
  const guardMode = crossChannelGuardMode();
  const { foodicsRef, priorBranchEarn } = await resolveCrossChannelEarnGuard({
    mode: guardMode,
    merchantId,
    orderId,
    contextRef: context?.foodicsOrderRef,
  });
  if (priorBranchEarn) {
    if (guardMode === 'enforce') {
      const { data: bal } = await supabaseAdmin.from('loyalty_cashback_balances')
        .select('balance_sar').eq('customer_id', customerId).eq('merchant_id', merchantId)
        .order('config_version', { ascending: false }).limit(1).maybeSingle();
      return { success: true, cashbackEarned: 0, newBalance: bal?.balance_sar ?? 0, alreadyEarned: true };
    }
    console.log('[cross-channel-dedup] would_skip', { merchantId, foodicsRef, orderId });
  }

  const { data: balRow } = await supabaseAdmin.from('loyalty_cashback_balances')
    .select('balance_sar, config_version')
    .eq('customer_id', customerId).eq('merchant_id', merchantId)
    .order('config_version', { ascending: false }).limit(1).maybeSingle();

  const currentVersion = config.config_version ?? 1;
  const expiresAt = config.expiry_months
    ? (() => { const d = new Date(); d.setMonth(d.getMonth() + config.expiry_months!); return d.toISOString(); })()
    : null;

  // Insert the earn transaction BEFORE updating the balance. A
  // partial unique index on (merchant_id, customer_id, order_id,
  // loyalty_type) WHERE type='earn' AND description NOT LIKE
  // 'Refunded%' protects against the Foodics double-webhook race
  // (incident 2026-05-15 where order 1778827451486 got 15.1 SAR
  // credited twice 100ms apart, slipping past the SELECT-then-
  // INSERT idempotency check above). If we lose the race the
  // INSERT fails with 23505 and we short-circuit — the winning
  // caller already credited the balance, so we just return the
  // current state.
  const txInsert = await supabaseAdmin.from('loyalty_transactions').insert({
    customer_id: customerId, merchant_id: merchantId, order_id: orderId,
    type: 'earn', loyalty_type: 'cashback', amount_sar: cashbackSar,
    points: 0, description: `Earned ${cashbackSar} SAR cashback`,
    source: 'app', expires_at: expiresAt, config_version: currentVersion,
    // Phase H8: stamped ONLY in enforce mode — in off/shadow the column
    // stays null so idx_loyalty_foodics_purchase_earn_unique stays dormant.
    ...(guardMode === 'enforce' && foodicsRef ? { foodics_order_ref: foodicsRef } : {}),
  });
  if (txInsert.error) {
    if ((txInsert.error as { code?: string }).code === '23505') {
      console.warn('[earnCashback] Race-loser insert skipped for order', orderId);
      const { data: currentBal } = await supabaseAdmin.from('loyalty_cashback_balances')
        .select('balance_sar').eq('customer_id', customerId).eq('merchant_id', merchantId)
        .order('config_version', { ascending: false }).limit(1).maybeSingle();
      return { success: true, cashbackEarned: 0, newBalance: currentBal?.balance_sar ?? 0, alreadyEarned: true };
    }
    throw new Error(txInsert.error.message);
  }

  // Insert won — now credit the balance.
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

  notifyPassUpdateSafe(customerId, merchantId);
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

  // M14 fix (2026-07-08): insert the reversal marker FIRST, under the partial
  // unique index loyalty_tx_cashback_restore_per_order
  // (customer_id, merchant_id, order_id) WHERE type='earn' AND
  // loyalty_type='cashback' AND source='refund'. If it conflicts, a prior or
  // concurrent restore already credited this order, so we credit nothing. This
  // mirrors earnCashback's insert-first ordering and closes the check-then-insert
  // double-credit race (the priorReverse SELECT above is only a fast path now).
  const { error: reversalInsertErr } = await supabaseAdmin
    .from('loyalty_transactions')
    .insert({
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
  if (reversalInsertErr) {
    if ((reversalInsertErr as { code?: string }).code === '23505') {
      // Lost the race / retry — the reversal already exists. Credit nothing.
      return { restoredSar: amount, alreadyRestored: true };
    }
    throw reversalInsertErr;
  }

  // We won the reversal insert — now credit the balance exactly once.
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

  notifyPassUpdateSafe(params.customerId, params.merchantId);
  return { restoredSar: amount, alreadyRestored: false };
}

/**
 * Phase 1 no-op shim. The old stamp-redemption table is gone, so there
 * are no per-order redemption rows to clear and no separate stamp count
 * to restore. The points balance that backed the redemption is already
 * refunded by the points-mode restore path that Phase 2 will introduce;
 * orders.ts still imports this for legacy refund call-sites and gets a
 * zeroed result. The function is kept exported (instead of deleted) so
 * Phase 2's cancellation refactor can land before this is removed.
 */
/**
 * Server-authoritative redemption of free-reward (points) milestones for an
 * order. Called from /commit so the deduction can't be skipped by a broken or
 * malicious client (the app previously fired a deprecated, key-less redeem call
 * that 400'd, so points were NEVER deducted → infinitely re-claimable freebie).
 *
 * Idempotent per (order, milestone): a retried commit finds the prior redeem
 * row and skips. Non-throwing per milestone — collects failures (insufficient
 * points / inactive / race) so the caller can keep the change non-blocking.
 */
export async function consumeOrderMilestones(
  customerId: string,
  merchantId: string,
  milestoneIds: string[],
  orderId: string,
): Promise<{ redeemed: string[]; deduplicated: string[]; failed: { milestoneId: string; reason: string }[] }> {
  if (!supabaseAdmin) throw new Error('Database not configured');
  const redeemed: string[] = [];
  const deduplicated: string[] = [];
  const failed: { milestoneId: string; reason: string }[] = [];

  for (const milestoneId of milestoneIds) {
    try {
      // Idempotency: one redemption per (order, milestone).
      const { data: prior } = await supabaseAdmin
        .from('loyalty_transactions')
        .select('id')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId)
        .eq('order_id', orderId)
        .eq('type', 'redeem')
        .eq('reference_type', 'milestone')
        .eq('reference_id', milestoneId)
        .maybeSingle();
      if (prior) { deduplicated.push(milestoneId); continue; }

      const { data: milestone } = await supabaseAdmin
        .from('loyalty_milestones')
        .select('id, points_threshold, reward_name, is_active')
        .eq('id', milestoneId)
        .eq('merchant_id', merchantId)
        .maybeSingle();
      if (!milestone || !milestone.is_active) {
        failed.push({ milestoneId, reason: 'milestone_not_found_or_inactive' });
        continue;
      }
      const threshold = Number(milestone.points_threshold);
      if (!Number.isFinite(threshold) || threshold <= 0) {
        failed.push({ milestoneId, reason: 'invalid_threshold' });
        continue;
      }

      const { data: bal } = await supabaseAdmin
        .from('loyalty_points')
        .select('points')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId)
        .maybeSingle();
      const current = Number(bal?.points ?? 0);
      if (current < threshold) {
        failed.push({ milestoneId, reason: 'insufficient_points' });
        continue;
      }

      // Ledger row first (audit anchor), then atomic .gte() deduct so a
      // concurrent redeem can't overdraw.
      const { data: txRow, error: txErr } = await supabaseAdmin
        .from('loyalty_transactions')
        .insert({
          customer_id: customerId,
          merchant_id: merchantId,
          order_id: orderId,
          type: 'redeem',
          loyalty_type: 'points',
          points: -threshold,
          description: `Redeemed milestone: ${milestone.reward_name ?? ''}`,
          source: 'app',
          reference_type: 'milestone',
          reference_id: milestoneId,
          metadata: { idempotency_key: `order:${orderId}:${milestoneId}`, milestone_name: milestone.reward_name ?? '' },
        })
        .select('id')
        .single();
      if (txErr || !txRow) {
        // 23505 = the partial unique index caught a concurrent/duplicate
        // redemption for this (order, milestone) — already consumed, no-op.
        if ((txErr as { code?: string } | null)?.code === '23505') { deduplicated.push(milestoneId); continue; }
        failed.push({ milestoneId, reason: txErr?.message ?? 'tx_insert_failed' });
        continue;
      }

      const { data: updated } = await supabaseAdmin
        .from('loyalty_points')
        .update({ points: current - threshold, updated_at: new Date().toISOString() })
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId)
        .gte('points', threshold)
        .select('points')
        .maybeSingle();
      if (!updated) {
        // Balance changed under us (concurrent redeem) — undo the ledger row.
        await supabaseAdmin.from('loyalty_transactions').delete().eq('id', txRow.id);
        failed.push({ milestoneId, reason: 'balance_changed' });
        continue;
      }
      redeemed.push(milestoneId);
    } catch (e: any) {
      failed.push({ milestoneId, reason: e?.message ?? 'error' });
    }
  }

  if (redeemed.length > 0) notifyPassUpdateSafe(customerId, merchantId);
  return { redeemed, deduplicated, failed };
}

/**
 * Reverse the milestone point deductions consumeOrderMilestones made for an
 * order (cancellation / refund). Idempotent: a 'milestone-refund' marker row
 * per milestone stops a double-restore. Returns the total points given back
 * (kept under the legacy stampsRestored field name for the caller).
 */
export async function restoreStampMilestonesForRefund(params: {
  customerId: string;
  merchantId: string;
  milestoneIds: string[];
  stampsConsumed: number;
  orderId: string;
}): Promise<{ stampsRestored: number; milestonesCleared: string[]; alreadyRestored: boolean }> {
  if (!supabaseAdmin) throw new Error('Database not configured');
  const cleared: string[] = [];
  let pointsRestored = 0;
  let anyAlready = false;

  const { data: redeems } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id, reference_id, points')
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId)
    .eq('order_id', params.orderId)
    .eq('type', 'redeem')
    .eq('reference_type', 'milestone');
  if (!redeems || redeems.length === 0) {
    return { stampsRestored: 0, milestonesCleared: [], alreadyRestored: false };
  }

  for (const row of redeems as Array<{ id: string; reference_id: string; points: number }>) {
    // Idempotency: skip if we already restored this milestone for this order.
    const { data: priorRestore } = await supabaseAdmin
      .from('loyalty_transactions')
      .select('id')
      .eq('customer_id', params.customerId)
      .eq('merchant_id', params.merchantId)
      .eq('order_id', params.orderId)
      .eq('type', 'earn')
      .eq('reference_type', 'milestone-refund')
      .eq('reference_id', row.reference_id)
      .maybeSingle();
    if (priorRestore) { anyAlready = true; cleared.push(String(row.reference_id)); continue; }

    const giveBack = Math.abs(Number(row.points) || 0);
    if (giveBack <= 0) continue;

    const { error: incErr } = await supabaseAdmin.rpc('increment_loyalty_points', {
      p_customer_id: params.customerId,
      p_merchant_id: params.merchantId,
      p_points: giveBack,
      p_config_version: 1,
    });
    if (incErr) { console.warn('[restoreMilestones] increment_loyalty_points failed:', incErr.message); continue; }

    await supabaseAdmin.from('loyalty_transactions').insert({
      customer_id: params.customerId,
      merchant_id: params.merchantId,
      order_id: params.orderId,
      type: 'earn',
      loyalty_type: 'points',
      points: giveBack,
      description: 'Refunded milestone (order cancelled)',
      source: 'refund',
      reference_type: 'milestone-refund',
      reference_id: row.reference_id,
      metadata: { idempotency_key: `refund:order:${params.orderId}:${row.reference_id}` },
    });
    pointsRestored += giveBack;
    cleared.push(String(row.reference_id));
  }

  if (pointsRestored > 0) notifyPassUpdateSafe(params.customerId, params.merchantId);
  return { stampsRestored: pointsRestored, milestonesCleared: cleared, alreadyRestored: anyAlready && pointsRestored === 0 };
}

/** POST /api/loyalty/redeem-cashback — redeem cashback SAR at checkout or via Foodics adapter */
loyaltyRouter.post('/redeem-cashback', async (req, res) => {
  try {
    // Accept either: user auth (app checkout) OR internal secret (Foodics adapter via nooksweb)
    // constant-time compare via shared helper — the previous inline
    // === check was a microsecond-level timing oracle.
    const hasInternalSecret = hasValidInternalSecret(req);
    if (!hasInternalSecret) {
      const { customerId } = req.body ?? {};
      if (!await requireMatchingCustomer(req, res, customerId)) return;
    }
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { customerId, merchantId, amountSar, orderId } = req.body;
    if (!customerId || !merchantId || !orderId) return res.status(400).json({ error: 'customerId, merchantId, orderId required' });
    const amount = +Number(amountSar).toFixed(2);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    // Phase B: when the caller is the customer's own app (not the
    // internal Foodics adapter via nooksweb), enforce the per-merchant
    // OTP gate. Internal-secret calls bypass — Foodics has its own
    // authentication chain at the POS and isn't tied to an OTP session.
    if (!hasInternalSecret) {
      const verification = await requireVerifiedAtMerchant(res, customerId, merchantId);
      if (!verification.ok) return;
    }

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

    notifyPassUpdateSafe(customerId, merchantId);
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
   MILESTONES — points-threshold rewards (renamed from stamps in Phase 1)
   ═══════════════════════════════════════════════════════════════════ */

/**
 * GET /api/loyalty/stamp-milestones?merchantId=X
 *
 * Endpoint URL kept (mobile clients still call it) but the underlying
 * table is now loyalty_milestones with points_threshold. We surface
 * the legacy field name `stamp_number` so the customer app keeps
 * compiling until Phase 3 rebuilds the screens.
 */
loyaltyRouter.get('/stamp-milestones', async (req, res) => {
  try {
    const merchantId = req.query.merchantId as string;
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabaseAdmin
      .from('loyalty_milestones')
      .select('id, points_threshold, reward_name, reward_description, reward_image_url, foodics_product_ids, is_active')
      .eq('merchant_id', merchantId)
      .eq('is_active', true)
      .order('points_threshold', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    const milestones = (data ?? []).map((m: { id: string; points_threshold: number; reward_name: string; reward_description: string | null; reward_image_url: string | null; foodics_product_ids: string[] | null; is_active: boolean }) => ({
      id: m.id,
      stamp_number: m.points_threshold,
      points_threshold: m.points_threshold,
      reward_name: m.reward_name,
      reward_description: m.reward_description,
      reward_image_url: m.reward_image_url,
      foodics_product_ids: m.foodics_product_ids ?? [],
      is_active: m.is_active,
    }));
    res.json({ milestones });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get milestones' });
  }
});

/**
 * POST /api/loyalty/redeem-milestone — Phase 3 points-mode redemption.
 *
 * Catalog-style (Starbucks-style) deduction: customer at 250 pts can
 * redeem a 150-pt reward → balance drops to 100. The same milestone
 * can be redeemed again later once the balance has accrued enough.
 * No one-time-unlock semantics.
 *
 * Body: { customerId, merchantId, milestoneId, idempotencyKey }
 * Auth: Bearer JWT (must match customerId, same pattern as /balance)
 *
 * Behavior:
 *   - Lookup milestone, verify merchant_id matches.
 *   - Idempotency: if a redeem tx with the same idempotency_key
 *     already exists for (customer, merchant) in the last 24h,
 *     return the previous result instead of re-deducting.
 *   - Atomic balance check + deduction via .gte() conditional update
 *     (prevents double-spend race; same pattern as /redeem and
 *     /redeem-cashback in this file).
 *   - Insert loyalty_transactions row: type='redeem', loyalty_type='points',
 *     points=-points_threshold, reference_type='milestone',
 *     reference_id=milestoneId, metadata={ idempotency_key, milestone_name }.
 *   - Rate limit: 10 redemptions / minute per customer per merchant.
 */
async function handleRedeemMilestone(req: Request, res: Response) {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { customerId, merchantId, milestoneId, idempotencyKey } = req.body ?? {};
    if (!customerId || !merchantId || !milestoneId || !idempotencyKey) {
      return res.status(400).json({
        error: 'customerId, merchantId, milestoneId, and idempotencyKey are required',
      });
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return res.status(400).json({ error: 'idempotencyKey must be 8-128 chars' });
    }

    if (!await requireMatchingCustomer(req, res, customerId)) return;

    // Rate limit: 10/min/(customer, merchant). Use the same enforceLimits
    // helper the rest of the server uses so we get the Upstash backend
    // when configured + in-memory fallback otherwise.
    if (
      !(await enforceLimits(req, res, {
        endpoint: 'loyalty.redeem-milestone',
        keys: [
          { dim: 'customer', value: `${customerId}:${merchantId}`, max: 10, windowMs: 60_000 },
        ],
        supabaseAdmin,
        merchantId,
      }))
    ) return;

    // ─── Idempotency check ───
    // Match on metadata->>'idempotency_key' within the last 24h.
    // If found, return the previous result without re-deducting.
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: priorRedeem } = await supabaseAdmin
      .from('loyalty_transactions')
      .select('id, points, metadata')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .eq('type', 'redeem')
      .eq('reference_type', 'milestone')
      .eq('reference_id', milestoneId)
      .gte('created_at', twentyFourHoursAgo)
      .order('created_at', { ascending: false })
      .limit(20);
    if (priorRedeem && priorRedeem.length > 0) {
      const match = priorRedeem.find((r) => {
        const meta = (r.metadata ?? {}) as { idempotency_key?: string };
        return meta.idempotency_key === idempotencyKey;
      });
      if (match) {
        // Return current balance + milestone details for the client.
        const { data: currentBalance } = await supabaseAdmin
          .from('loyalty_points')
          .select('points')
          .eq('customer_id', customerId)
          .eq('merchant_id', merchantId)
          .maybeSingle();
        const { data: milestoneRow } = await supabaseAdmin
          .from('loyalty_milestones')
          .select('reward_name, foodics_product_ids')
          .eq('id', milestoneId)
          .eq('merchant_id', merchantId)
          .maybeSingle();
        return res.json({
          success: true,
          newBalance: currentBalance?.points ?? 0,
          redemptionId: match.id,
          milestoneRewardName: milestoneRow?.reward_name ?? '',
          foodicsProductIds: milestoneRow?.foodics_product_ids ?? [],
          deduplicated: true,
        });
      }
    }

    // ─── Look up milestone (merchant-scoped) ───
    const { data: milestone, error: milestoneErr } = await supabaseAdmin
      .from('loyalty_milestones')
      .select('id, points_threshold, reward_name, foodics_product_ids, is_active, merchant_id')
      .eq('id', milestoneId)
      .eq('merchant_id', merchantId)
      .maybeSingle();
    if (milestoneErr || !milestone) {
      return res.status(404).json({ error: 'Milestone not found for this merchant' });
    }
    if (!milestone.is_active) {
      return res.status(404).json({ error: 'Milestone is not active' });
    }
    const pointsThreshold = Number(milestone.points_threshold);
    if (!Number.isFinite(pointsThreshold) || pointsThreshold <= 0) {
      return res.status(500).json({ error: 'Invalid milestone points_threshold' });
    }

    await ensureLoyaltyMemberProfile(merchantId, customerId);

    // ─── Read current balance ───
    const { data: balanceRow } = await supabaseAdmin
      .from('loyalty_points')
      .select('points')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .maybeSingle();
    const currentPoints = balanceRow?.points ?? 0;
    if (currentPoints < pointsThreshold) {
      return res.status(400).json({
        error: 'Not enough points',
        needed: pointsThreshold,
        current: currentPoints,
      });
    }

    // ─── Insert transaction FIRST, then deduct ───
    // Commit-before-deduct discipline: the transaction row is the
    // audit-trail anchor; if the balance update fails we still have
    // a record of the attempt. The balance update is atomic with a
    // .gte() guard so a concurrent redemption can't overdraw.
    const { data: txRow, error: txErr } = await supabaseAdmin
      .from('loyalty_transactions')
      .insert({
        customer_id: customerId,
        merchant_id: merchantId,
        order_id: `milestone-redeem:${milestoneId}:${idempotencyKey}`,
        type: 'redeem',
        loyalty_type: 'points',
        points: -pointsThreshold,
        description: `Redeemed milestone: ${milestone.reward_name ?? ''}`,
        source: 'app',
        reference_type: 'milestone',
        reference_id: milestoneId,
        metadata: {
          idempotency_key: idempotencyKey,
          milestone_name: milestone.reward_name ?? '',
        },
      })
      .select('id')
      .single();
    if (txErr || !txRow) {
      return res.status(500).json({ error: txErr?.message || 'Failed to record redemption' });
    }

    // Atomic conditional balance deduct — .gte() guarantees we don't
    // overdraw if a concurrent redeem already ran.
    const { data: updatedBalance, error: updateErr } = await supabaseAdmin
      .from('loyalty_points')
      .update({
        points: currentPoints - pointsThreshold,
        updated_at: new Date().toISOString(),
      })
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .gte('points', pointsThreshold)
      .select('points')
      .maybeSingle();
    if (updateErr || !updatedBalance) {
      // Roll back the transaction row we inserted — the balance
      // didn't drop, so we shouldn't leave a redemption record.
      await supabaseAdmin.from('loyalty_transactions').delete().eq('id', txRow.id);
      return res.status(409).json({
        error: 'Redemption failed — balance changed during processing. Please try again.',
      });
    }

    notifyPassUpdateSafe(customerId, merchantId);

    return res.json({
      success: true,
      newBalance: updatedBalance.points,
      redemptionId: txRow.id,
      milestoneRewardName: milestone.reward_name ?? '',
      foodicsProductIds: milestone.foodics_product_ids ?? [],
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to redeem milestone' });
  }
}

loyaltyRouter.post('/redeem-milestone', handleRedeemMilestone);

// Back-compat alias — the mobile app's older builds still POST to the
// stamp-flavored URL. Same handler, no special-case for the legacy path.
loyaltyRouter.post('/redeem-stamp-milestone', handleRedeemMilestone);

/**
 * POST /api/loyalty/internal/notify-pass-update
 * Body: { customerId, merchantId }
 *
 * Internal-only — fires the Apple Wallet pass push notification for
 * one customer's pass. Called by nooksweb after a kiosk walk-in claim
 * lands so the customer's pass refreshes without them having to open
 * the Nooks app. Uses requireNooksInternalRequest to gate by shared
 * secret — never exposed to the public internet.
 */
loyaltyRouter.post('/internal/notify-pass-update', async (req, res) => {
  if (!requireNooksInternalRequest(req, res)) return;
  const { customerId, merchantId } = req.body ?? {};
  if (typeof customerId !== 'string' || typeof merchantId !== 'string') {
    return res.status(400).json({ error: 'customerId and merchantId required' });
  }
  notifyPassUpdateSafe(customerId, merchantId);
  res.json({ ok: true });
});

/**
 * POST /api/loyalty/unredeem-milestone
 *
 * Body: { customerId, merchantId, redemptionId }
 *
 * Refunds a points redemption when the customer removes the reward from
 * their cart before checkout. Without this, points are deducted at
 * redeem-milestone time but the reward isn't actually consumed if the
 * customer changes their mind — they'd lose points for nothing.
 *
 * Atomic flow (mirrors redeem-milestone in reverse):
 *   1. Look up the redemption transaction by id (scoped to customer+merchant)
 *   2. Verify it hasn't already been refunded (idempotent — second call no-ops)
 *   3. Verify the originating order_id doesn't exist as a committed customer_order
 *      (once they checked out, the points are spent and shouldn't refund)
 *   4. Insert an opposing 'refund' transaction with positive points
 *   5. Increment loyalty_points + lifetime is NOT bumped (refund isn't earning)
 *   6. Mark the original transaction's metadata.refunded_at so we don't
 *      double-refund
 *
 * Rate-limit: 30/min per customer/merchant — same as redeem.
 */
async function handleUnredeemMilestone(req: any, res: any) {
  try {
    const { customerId, merchantId, redemptionId } = req.body ?? {};
    if (!customerId || !merchantId || !redemptionId) {
      return res.status(400).json({ error: 'customerId, merchantId, redemptionId required' });
    }

    // AuthZ: bind to the verified Supabase user, same as redeem-milestone.
    // Without this an unauthenticated caller could refund a milestone
    // redemption into any (customer, merchant) balance (audit finding).
    if (!(await requireMatchingCustomer(req, res, customerId))) return;

    // Same rate-limit family as redeem so a customer mashing add/remove
    // can't generate ledger spam. enforceLimits returns true on pass,
    // false when it has already sent a 429 — we just return early then.
    if (
      !(await enforceLimits(req, res, {
        endpoint: 'loyalty.unredeem-milestone',
        keys: [
          { dim: 'customer', value: `${customerId}:${merchantId}`, max: 30, windowMs: 60_000 },
        ],
        supabaseAdmin,
        merchantId,
      }))
    ) {
      return;
    }

    if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });

    // Find the original redemption (must belong to this customer + merchant,
    // must be a 'redeem' row, must reference an active milestone).
    const { data: original } = await supabaseAdmin
      .from('loyalty_transactions')
      .select('id, points, customer_id, merchant_id, type, reference_id, metadata, order_id')
      .eq('id', redemptionId)
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .eq('type', 'redeem')
      .maybeSingle();
    if (!original) {
      return res.status(404).json({ error: 'Redemption not found' });
    }

    // Idempotency: if we already refunded this redemption, return success
    // without doing anything. Lets the cart-context fire the refund call
    // multiple times safely (e.g. on every remove → re-add → remove cycle).
    const alreadyRefundedAt = (original.metadata as Record<string, unknown> | null)?.refunded_at;
    if (alreadyRefundedAt) {
      return res.json({
        success: true,
        deduplicated: true,
        refundedAt: alreadyRefundedAt,
      });
    }

    // Guard against refunding after checkout. If the customer actually
    // completed the order, the reward was consumed and the points are
    // legitimately spent — DO NOT refund.
    if (original.order_id && !String(original.order_id).startsWith('milestone-redeem:')) {
      const { data: completedOrder } = await supabaseAdmin
        .from('customer_orders')
        .select('id, foodics_order_id, payment_confirmed_at')
        .eq('id', original.order_id)
        .maybeSingle();
      if (completedOrder?.foodics_order_id || completedOrder?.payment_confirmed_at) {
        return res.status(409).json({
          error: 'Order already completed — points are non-refundable',
        });
      }
    }

    // Points value is negative on a redeem row; abs() to add back.
    const pointsToRefund = Math.abs(Number(original.points ?? 0));
    if (pointsToRefund === 0) {
      return res.status(400).json({ error: 'Original redemption has zero points' });
    }

    const nowIso = new Date().toISOString();

    // 1. Insert the refund transaction (positive points). Use a 'redeem'
    //    type with a marker in metadata rather than a separate 'refund'
    //    type to keep the existing balance computation working — the
    //    ledger sums all 'earn'+'redeem' rows.
    const { data: refundRow, error: refundErr } = await supabaseAdmin
      .from('loyalty_transactions')
      .insert({
        customer_id: customerId,
        merchant_id: merchantId,
        type: 'redeem',
        loyalty_type: 'points',
        points: pointsToRefund, // positive = refund
        source: 'app',
        reference_type: 'milestone_refund',
        reference_id: String(original.reference_id ?? ''),
        order_id: `milestone-refund:${redemptionId}`,
        description: 'Refund: reward removed from cart',
        metadata: {
          refund_of: redemptionId,
          original_milestone_id: original.reference_id,
        },
      })
      .select('id')
      .single();
    if (refundErr || !refundRow) {
      return res.status(500).json({ error: refundErr?.message || 'Refund insert failed' });
    }

    // 2. Mark the original redemption as refunded — prevents double-refund
    //    on the next call.
    await supabaseAdmin
      .from('loyalty_transactions')
      .update({
        metadata: {
          ...(original.metadata as Record<string, unknown> | null ?? {}),
          refunded_at: nowIso,
          refund_transaction_id: refundRow.id,
        },
      })
      .eq('id', redemptionId);

    // 3. Increment the points balance (do NOT touch lifetime_points —
    //    a refund isn't earning). Read-modify-write because Supabase
    //    doesn't expose atomic UPDATE-by-expression in the JS client.
    const { data: pts } = await supabaseAdmin
      .from('loyalty_points')
      .select('points')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .maybeSingle();
    const currentBalance = Number(pts?.points ?? 0);
    const newBalance = currentBalance + pointsToRefund;
    if (pts) {
      await supabaseAdmin
        .from('loyalty_points')
        .update({ points: newBalance, updated_at: nowIso })
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId);
    } else {
      await supabaseAdmin.from('loyalty_points').insert({
        customer_id: customerId,
        merchant_id: merchantId,
        points: pointsToRefund,
        lifetime_points: 0,
      });
    }

    // 4. Audit log
    await supabaseAdmin.from('audit_log').insert({
      merchant_id: merchantId,
      action: 'loyalty.milestone_refunded',
      payload: {
        customer_id: customerId,
        redemption_id: redemptionId,
        refund_transaction_id: refundRow.id,
        points_refunded: pointsToRefund,
        reason: 'cart_removal',
      },
    });

    return res.json({
      success: true,
      pointsRefunded: pointsToRefund,
      newBalance,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to refund redemption' });
  }
}

loyaltyRouter.post('/unredeem-milestone', handleUnredeemMilestone);

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
    // Phase 1: stamp_* columns are no longer writable (stamps mode dropped).
    const configPayload: Record<string, unknown> = { merchant_id: merchantId };
    const allowedFields = [
      'earn_mode', 'points_per_sar', 'points_per_order', 'point_value_sar',
      'expiry_months',
      'wallet_card_bg_color', 'wallet_card_text_color', 'wallet_card_logo_url',
      'wallet_card_label', 'wallet_card_secondary_label', 'pass_template_type',
    ];
    for (const key of allowedFields) {
      if (key in newConfig) configPayload[key] = newConfig[key];
    }

    await supabaseAdmin
      .from('loyalty_config')
      .upsert(configPayload, { onConflict: 'merchant_id' });
    invalidateMerchantConfigCache(merchantId);

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

/**
 * POST /api/loyalty/restore-pos-redemption
 *
 * Reverses cashback deductions tied to a Foodics POS order_id.
 *
 * Context: when a Foodics cashier scans a customer's QR and applies
 * a cashback redemption at the POS, nooksweb's /api/adapter/v1/redeem
 * deducts the customer's balance immediately so the POS can apply the
 * discount line. If that POS order is later voided in Foodics, this
 * endpoint puts the cashback back.
 *
 * Phase 1: the stamps reversal branch is gone (stamps mode dropped).
 * Phase 2 will add a points-mode reversal path here.
 *
 * Idempotent — restoreCashbackForRefund gates on a 'refund' marker
 * transaction and skips if it exists, so re-firing on webhook retry
 * is safe.
 */
loyaltyRouter.post('/restore-pos-redemption', async (req, res) => {
  try {
    if (!requireNooksInternalRequest(req, res)) return;
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { orderId, merchantId } = req.body ?? {};
    if (!orderId || !merchantId) {
      return res.status(400).json({ error: 'orderId and merchantId required' });
    }

    const { data: redeemTxs, error: txErr } = await supabaseAdmin
      .from('loyalty_transactions')
      .select('id, customer_id, loyalty_type, amount_sar, points')
      .eq('merchant_id', merchantId)
      .eq('order_id', orderId)
      .eq('type', 'redeem');
    if (txErr) {
      return res.status(500).json({ error: txErr.message });
    }
    if (!redeemTxs || redeemTxs.length === 0) {
      return res.json({ success: true, restored: { cashback: [], stamps: [] }, noOp: true });
    }

    const cashbackRestored: Array<{ customerId: string; amountSar: number; alreadyRestored: boolean }> = [];

    // Cashback reversals — one per customer that had cashback deducted
    // on this POS order.
    const cashbackByCustomer = new Map<string, number>();
    for (const tx of redeemTxs) {
      const amount = Math.abs(Number(tx.amount_sar ?? 0));
      if (tx.loyalty_type === 'cashback' && amount > 0) {
        cashbackByCustomer.set(tx.customer_id, (cashbackByCustomer.get(tx.customer_id) ?? 0) + amount);
      }
    }

    for (const [customerId, amountSar] of cashbackByCustomer) {
      const result = await restoreCashbackForRefund({
        customerId,
        merchantId,
        amountSar,
        orderId,
      });
      cashbackRestored.push({ customerId, amountSar: result.restoredSar, alreadyRestored: result.alreadyRestored });
    }

    res.json({ success: true, restored: { cashback: cashbackRestored, stamps: [] as Array<{ customerId: string; stamps: number; milestonesCleared: string[]; alreadyRestored: boolean }> } });
  } catch (err: any) {
    console.error('[loyalty] restore-pos-redemption error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to restore POS redemption' });
  }
});
