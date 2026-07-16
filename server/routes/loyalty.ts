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
    .in('source', ['branch', 'walkin'])
    .in('reference_id', crossChannelEarnReferenceIds(foodicsRef))
    .limit(1)
    .maybeSingle();
  return { foodicsRef, priorBranchEarn: Boolean(branchEarn) };
}

/**
 * LOY-9: a prior earn for this physical purchase can come from either the
 * branch/POS channel OR a kiosk walk-in capture (source='walkin'). Both key
 * idempotency on the Foodics order uuid, so include both in the dedup lookup.
 * LOY-B (2026-07-10): branch/app earns store the BARE foodics uuid in
 * reference_id, but the kiosk walk-in path writes it prefixed as
 * 'walkin_<uuid>'. Matching only the bare uuid missed the kiosk row, so a
 * race between the app final-commit and the walk-in sync could double-earn.
 * Match BOTH forms. Exported for unit tests.
 */
export function crossChannelEarnReferenceIds(foodicsRef: string): string[] {
  return [foodicsRef, `walkin_${foodicsRef}`];
}

function normalizeOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Normalize a Supabase RPC result for a function that `RETURNS jsonb`. The JS
 * client hands back the object directly for a scalar jsonb function, but wraps
 * single-row set-returning functions in a one-element array — accept both so
 * callers can read `.status` / `.new_balance` uniformly.
 */
function rpcResultObject(data: unknown): Record<string, any> | null {
  if (!data) return null;
  if (Array.isArray(data)) return (data[0] as Record<string, any>) ?? null;
  return typeof data === 'object' ? (data as Record<string, any>) : null;
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

  // LOY-A (2026-07-10): points are NEVER cash. Converting a points balance
  // into a SAR monetary discount (points × point_value_sar) is disallowed on
  // EVERY channel that reaches this function — including the internal Foodics
  // POS adapter (/api/loyalty/redeem via internal secret) and the dashboard
  // branch tool (/api/loyalty/branch/redeem-points). Only reward-item /
  // milestone redemption (redeemRewardFromBalance) may spend a points balance.
  // This mirrors the customer-self-service invariant already enforced at the
  // top of POST /api/loyalty/redeem (403). Cashback (SAR-denominated) is
  // unaffected — it legitimately reduces a monetary charge and does not flow
  // through this function. Default per owner decision: block it.
  const activeLoyaltyType = await getCustomerActiveLoyaltyType(params.merchantId, params.customerId);
  const effectiveLoyaltyType = activeLoyaltyType ?? config.loyalty_type ?? 'points';
  if (effectiveLoyaltyType === 'points') {
    const blocked = new Error('Points can only be redeemed for rewards, not as a cash discount.') as Error & { code?: string };
    blocked.code = 'POINTS_CASH_REDEMPTION_DISABLED';
    throw blocked;
  }

  const programId = await getActiveProgramId(params.merchantId);
  const pointsToRedeem = Math.floor(Number(params.points));
  if (pointsToRedeem <= 0) throw new Error('Invalid points amount');

  const discountSar = +(pointsToRedeem * config.point_value_sar).toFixed(2);

  // LOY-1 / LOY-4: atomic deduct + ledger insert via the SECURITY DEFINER
  // redeem_loyalty_points RPC. It guards `points >= x` (no read-modify-write
  // double-spend race) and inserts the redeem row under the partial unique
  // index idx_loyalty_tx_points_redeem_per_order keyed on
  // (merchant_id, customer_id, order_id) — so a Foodics double-fire / client
  // retry that replays the SAME order_id dedups instead of deducting twice.
  // The /redeem route requires a real orderId (400 otherwise) and
  // /branch/redeem-points derives a stable `branch-redeem:<ref>` id, so the
  // per-order index always has a stable key to arbitrate on.
  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('redeem_loyalty_points', {
    p_customer_id: params.customerId,
    p_merchant_id: params.merchantId,
    p_points: pointsToRedeem,
    p_order_id: params.orderId,
    p_reference_type: normalizeOptionalString(params.context?.referenceType),
    p_reference_id: normalizeOptionalString(params.context?.referenceId),
    p_source: normalizeOptionalString(params.context?.source) ?? 'app',
    p_description: `Redeemed ${pointsToRedeem} points for ${discountSar} SAR discount`,
    p_program_id: programId,
    p_branch_id: params.context?.branchId ?? null,
    p_actor_user_id: params.context?.actorUserId ?? null,
    p_actor_role: params.context?.actorRole ?? null,
  });
  if (rpcErr) throw new Error(rpcErr.message);
  const rpcResult = rpcResultObject(rpcData);
  const status = rpcResult?.status;
  if (status === 'insufficient') {
    // Route maps /insufficient points/i → HTTP 400 (unchanged behavior).
    throw new Error('Insufficient points');
  }
  const newBalance = Number(rpcResult?.new_balance ?? 0);

  notifyPassUpdateSafe(params.customerId, params.merchantId);
  return {
    success: true,
    pointsRedeemed: pointsToRedeem,
    discountSar,
    newBalance,
    // status === 'duplicate' → same order already redeemed; return the prior
    // redemption idempotently (the RPC did not deduct again).
    ...(status === 'duplicate' ? { deduplicated: true } : {}),
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

  // LOY-1: atomic deduct + ledger via redeem_loyalty_points. Replaces the
  // read-modify-write `.gte()` update (double-spend race) with the SECURITY
  // DEFINER RPC, which guards the balance and inserts the redeem row in one
  // transaction. order_id = referenceId so a stable caller-supplied reference
  // dedups on the per-order unique index (the default time-based reference is
  // unique per call, matching the prior no-idempotency behavior).
  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('redeem_loyalty_points', {
    p_customer_id: params.customerId,
    p_merchant_id: params.merchantId,
    p_points: reward.points_cost,
    p_order_id: referenceId,
    p_reference_type: normalizeOptionalString(params.context?.referenceType) ?? 'reward',
    p_reference_id: referenceId,
    p_source: normalizeOptionalString(params.context?.source) ?? 'app',
    p_description: `Redeemed reward: ${reward.name}`,
    p_program_id: null,
    p_branch_id: params.context?.branchId ?? null,
    p_actor_user_id: params.context?.actorUserId ?? null,
    p_actor_role: params.context?.actorRole ?? null,
    p_metadata: { reward_id: reward.id, reward_name: reward.name },
  });
  if (rpcErr) throw new Error(rpcErr.message);
  const rpcResult = rpcResultObject(rpcData);
  const status = rpcResult?.status;
  if (status === 'insufficient') {
    throw new Error('Insufficient points');
  }
  const newBalance = Number(rpcResult?.new_balance ?? 0);

  notifyPassUpdateSafe(params.customerId, params.merchantId);
  return {
    success: true,
    reward: reward.name,
    pointsSpent: reward.points_cost,
    newBalance,
    ...(status === 'duplicate' ? { deduplicated: true } : {}),
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
      .select('id, status, customer_id, merchant_id, total_sar, wallet_paid_sar, cashback_paid_sar')
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

    // LOY-7 / LOY-8 / M15: derive the earn base from the DB order row, never the
    // caller's `orderSubtotal`. Canonical base = net-of-loyalty =
    // total_sar - wallet_paid_sar - cashback_paid_sar, clamped ≥ 0. This is
    // channel-independent and identical to netOfLoyaltyEarnBase() in orders.ts,
    // so one physical purchase earns the same regardless of which path fires and
    // a buggy/compromised internal caller cannot inflate the base via the body.
    const orderRow = orderCheck.data as {
      total_sar?: number | null;
      wallet_paid_sar?: number | null;
      cashback_paid_sar?: number | null;
    };
    const earnBase = Math.max(
      0,
      Number(
        (
          Number(orderRow.total_sar ?? 0) -
          Number(orderRow.wallet_paid_sar ?? 0) -
          Number(orderRow.cashback_paid_sar ?? 0)
        ).toFixed(2),
      ),
    );

    if (loyaltyType === 'cashback') {
      const result = await earnCashback(merchantId || '', customerId, orderId, earnBase);
      return res.json(result);
    }

    // Default: points
    const result = await earnPoints(customerId, orderId, earnBase, merchantId || '');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to earn' });
  }
});

/**
 * Shared earn logic – callable from routes and from order status handler
 */
/**
 * LOY-13: type-aware earn dispatcher for the app order-lifecycle paths
 * (Delivered / customer-received). Mirrors the /earn route's branch so a
 * cashback merchant's customer earns CASHBACK, not points, regardless of
 * which server path fires the earn. `earnBase` is the already-computed
 * net-of-loyalty base (callers use netOfLoyaltyEarnBase). Idempotency is
 * enforced inside earnPoints/earnCashback via the partial unique indexes.
 */
export async function earnForOrder(
  customerId: string,
  orderId: string,
  earnBase: number,
  merchantId: string,
  context?: LoyaltyActionContext,
): Promise<unknown> {
  if (!merchantId || !customerId) return { success: false, skipped: 'missing_ids' };
  if (!supabaseAdmin) throw new Error('Database not configured');
  const config = await getMerchantConfig(merchantId);
  if (!config.loyalty_type) return { success: false, skipped: 'no_loyalty' };
  const loyaltyType = await initCustomerLoyaltyType(merchantId, customerId, config.loyalty_type);
  if (loyaltyType === 'cashback') {
    return earnCashback(merchantId, customerId, orderId, earnBase, context);
  }
  return earnPoints(customerId, orderId, earnBase, merchantId, context);
}

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

  // Atomic + idempotent ledger-insert + balance-credit via the
  // earn_loyalty_points RPC (SECURITY DEFINER, one DB transaction). This
  // replaces the old two-step ledger-INSERT-then-increment-RPC sequence: a
  // hard process kill between those two writes used to leave the ledger row
  // committed with no balance credit, and every retry after that hit the
  // ledger row on the idempotency check and returned pointsEarned: 0 —
  // silently losing the customer's points. Now the insert and the credit
  // either both commit or neither does, so a crash anywhere in between is
  // safe to retry. The ledger insert inside the RPC dedups against ALL
  // THREE partial unique earn indexes (idx_loyalty_transactions_app_earn_unique,
  // idx_loyalty_normal_earn_unique, idx_loyalty_foodics_purchase_earn_unique) —
  // whichever one a repeat/race call trips, the RPC returns status:
  // 'duplicate' without crediting again. (The SELECT idempotency check above
  // is a fast path for the common already-earned case; this is the atomic
  // backstop.)
  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('earn_loyalty_points', {
    p_customer_id: customerId,
    p_merchant_id: merchantId,
    p_points: pointsEarned,
    p_order_id: orderId,
    p_description: `Earned ${pointsEarned} points`,
    p_expires_at: expiresAt,
    p_program_id: programId ?? null,
    p_branch_id: normalizeOptionalString(context?.branchId),
    p_source: normalizeOptionalString(context?.source) ?? 'app',
    p_actor_user_id: normalizeOptionalString(context?.actorUserId),
    p_actor_role: normalizeOptionalString(context?.actorRole),
    p_reference_type: normalizeOptionalString(context?.referenceType),
    p_reference_id: normalizeOptionalString(context?.referenceId),
    // Phase H8: stamped ONLY in enforce mode — in off/shadow the column
    // stays null so idx_loyalty_foodics_purchase_earn_unique stays dormant.
    p_foodics_order_ref: guardMode === 'enforce' && foodicsRef ? foodicsRef : null,
    p_config_version: config?.config_version ?? 1,
    p_metadata: context?.metadata ?? {},
  });
  if (rpcErr) {
    console.error('[earnPoints] earn_loyalty_points RPC failed:', rpcErr.message);
    throw new Error(`Loyalty points earn failed: ${rpcErr.message}`);
  }
  const rpcResult = rpcResultObject(rpcData);
  const rpcNewBalance = typeof rpcResult?.new_balance === 'number' ? rpcResult.new_balance : null;

  if (rpcResult?.status === 'duplicate') {
    // Race-loser / retry — already earned for this order. No credit again.
    return { success: true, pointsEarned: 0, newBalance: rpcNewBalance ?? 0 };
  }
  if (rpcResult?.status !== 'ok') {
    // The RPC only ever returns 'ok' or 'duplicate' (anything else raises and
    // surfaces as rpcErr above), so an unrecognized result means we are
    // talking to an unexpected function version. Fail loud rather than report
    // points we cannot prove were credited.
    console.error('[earnPoints] earn_loyalty_points returned an unexpected result:', rpcResult);
    throw new Error('Loyalty points earn failed: unexpected RPC result');
  }

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
      // Points are NOT cash. Customer-facing points redemption happens
      // only through reward items (/redeem-reward, /redeem-milestone) —
      // this endpoint converts points into a SAR discount at
      // point_value_sar, which the checkout used to expose as a
      // cashback-style toggle for points customers. Internal-secret
      // callers (nooksweb Foodics adapter / branch tools) keep access;
      // the customer app gets a hard refusal BEFORE any deduction.
      return res.status(403).json({
        error: 'Points can only be redeemed for rewards.',
        code: 'POINTS_CASH_REDEMPTION_DISABLED',
      });
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
    // LOY-A: points-as-cash is blocked for points merchants/customers.
    if (err?.code === 'POINTS_CASH_REDEMPTION_DISABLED') {
      return res.status(403).json({ error: err.message, code: err.code });
    }
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
    // LOY-A: points-as-cash is blocked for points merchants/customers — the
    // branch tool may still redeem reward items via /branch/redeem-reward.
    if (err?.code === 'POINTS_CASH_REDEMPTION_DISABLED') {
      return res.status(403).json({ error: err.message, code: err.code });
    }
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
 * A redemption INSTANCE = one or more cart lines sharing (milestoneId,
 * lineKey). lineKey is the rewards-screen pre-redemption idempotency key
 * (parsed out of the cart uniqueId `reward-<mid>-<fid>-<key>`); null means
 * an "at-commit" (checkout-toggle) instance with no prior pre-redemption.
 * fids = the distinct foodics_product_ids across this instance's cart
 * lines, used for product-binding checks. See reward_stacking_design.md §3.
 */
export type RewardInstance = { milestoneId: string; lineKey: string | null; fids: string[] };

/**
 * Server-authoritative redemption of free-reward (points) milestones for an
 * order. Called from /commit so the deduction can't be skipped by a broken or
 * malicious client (the app previously fired a deprecated, key-less redeem call
 * that 400'd, so points were NEVER deducted → infinitely re-claimable freebie).
 *
 * Idempotent per instance (order, milestone[, lineKey]): a retried commit
 * finds the prior redeem row and skips. Non-throwing per instance — collects
 * failures (insufficient points / inactive / race / pre_redemption_unavailable)
 * so the caller can keep the change non-blocking.
 *
 * Back-compat: legacy callers may still pass a bare `milestoneId[]` (the
 * pre-stacking shape) — each id is treated as a keyless (lineKey=null)
 * instance, which reproduces today's exact behavior byte-for-byte (see the
 * "Keyless instance" branch below). New callers pass `RewardInstance[]`
 * directly, processed keyed-first-then-keyless (design §4).
 */
export async function consumeOrderMilestones(
  customerId: string,
  merchantId: string,
  milestoneIds: string[],
  orderId: string,
): Promise<{ redeemed: string[]; deduplicated: string[]; failed: { milestoneId: string; reason: string }[] }>;
export async function consumeOrderMilestones(
  customerId: string,
  merchantId: string,
  instances: RewardInstance[],
  orderId: string,
): Promise<{ redeemed: string[]; deduplicated: string[]; failed: { milestoneId: string; reason: string }[] }>;
export async function consumeOrderMilestones(
  customerId: string,
  merchantId: string,
  input: string[] | RewardInstance[],
  orderId: string,
): Promise<{ redeemed: string[]; deduplicated: string[]; failed: { milestoneId: string; reason: string }[] }> {
  if (!supabaseAdmin) throw new Error('Database not configured');
  const instances: RewardInstance[] =
    input.length === 0
      ? []
      : typeof input[0] === 'string'
        ? (input as string[]).map((milestoneId) => ({ milestoneId, lineKey: null, fids: [] }))
        : (input as RewardInstance[]);

  const redeemed: string[] = [];
  const deduplicated: string[] = [];
  const failed: { milestoneId: string; reason: string }[] = [];

  const preRedeemOrderId = (mid: string, lineKey: string) => `milestone-redeem:${mid}:${lineKey}`;
  const instanceKeyOf = (inst: RewardInstance) =>
    inst.lineKey != null ? `${orderId}:m:${inst.milestoneId}:k:${inst.lineKey}` : `${orderId}:m:${inst.milestoneId}`;

  // Keyed-first-then-keyless (design §4) — keyed instances are backed by an
  // exact, already-known pre-redemption row and must never silently fall
  // back to a live-balance deduction; keyless instances (today's only shape)
  // are processed last so their legacy R1 spare-scan naturally excludes
  // whatever this order's keyed instances already claimed.
  const keyedTargetOrderIds = new Set(
    instances.filter((i) => i.lineKey != null).map((i) => preRedeemOrderId(i.milestoneId, i.lineKey as string)),
  );
  const ordered = [...instances.filter((i) => i.lineKey != null), ...instances.filter((i) => i.lineKey == null)];

  for (const inst of ordered) {
    try {
      // Per-instance idempotency key (design §2). Pre-paid instances get a
      // 0-point marker keyed under `...:k:<lineKey>`; keyless/at-commit
      // instances are UNCHANGED (`<orderId>:m:<mid>`) — the A4 partial
      // unique index idx_loyalty_tx_points_redeem_per_order is scoped to
      // (merchant_id, customer_id, order_id) so this namespacing keeps every
      // instance's dedup independent, including N instances of one milestone.
      const milestoneOrderId = instanceKeyOf(inst);

      // Idempotency fast-path: a retried commit already processed this instance.
      const { data: prior } = await supabaseAdmin
        .from('loyalty_transactions')
        .select('id')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId)
        .eq('order_id', milestoneOrderId)
        .eq('type', 'redeem')
        .maybeSingle();
      if (prior) { deduplicated.push(inst.milestoneId); continue; }

      const { data: milestone } = await supabaseAdmin
        .from('loyalty_milestones')
        .select('id, points_threshold, reward_name, is_active')
        .eq('id', inst.milestoneId)
        .eq('merchant_id', merchantId)
        .maybeSingle();
      if (!milestone || !milestone.is_active) {
        failed.push({ milestoneId: inst.milestoneId, reason: 'milestone_not_found_or_inactive' });
        continue;
      }
      const threshold = Number(milestone.points_threshold);
      if (!Number.isFinite(threshold) || threshold <= 0) {
        failed.push({ milestoneId: inst.milestoneId, reason: 'invalid_threshold' });
        continue;
      }

      if (inst.lineKey != null) {
        // ── Keyed instance: must be backed by its OWN pre-redemption row,
        // claimed via a CAS conditional update (closes L2 — a read-then-
        // unconditional-update let two concurrent commits both claim the
        // same row). No balance fallback: authorize (§3) never approved
        // one, so consuming one here would be an unbacked free item.
        const targetOrderId = preRedeemOrderId(inst.milestoneId, inst.lineKey);

        const { data: preRow } = await supabaseAdmin
          .from('loyalty_transactions')
          .select('id, metadata')
          .eq('customer_id', customerId)
          .eq('merchant_id', merchantId)
          .eq('type', 'redeem')
          .eq('loyalty_type', 'points')
          .eq('reference_type', 'milestone')
          .eq('reference_id', inst.milestoneId)
          .eq('order_id', targetOrderId)
          .maybeSingle();

        let claimedPreRowId: string | null = null;
        if (preRow) {
          const priorMeta = (preRow.metadata as Record<string, unknown> | null) ?? {};
          // Fresh-read-then-conditional-write: the WHERE clause (not the
          // read above) is the actual CAS — Postgres re-evaluates it under
          // row lock at UPDATE time, so a merge here can never resurrect a
          // guard another writer already cleared.
          const { data: claimRows } = await supabaseAdmin
            .from('loyalty_transactions')
            .update({
              metadata: { ...priorMeta, consumed_by_order: orderId, consumed_at: new Date().toISOString() },
            })
            .eq('id', preRow.id)
            .is('metadata->>consumed_by_order', null)
            .is('metadata->>refunded_at', null)
            .select('id');
          if (claimRows && claimRows.length === 1) claimedPreRowId = claimRows[0].id;
        }

        if (!claimedPreRowId) {
          // Lost the CAS (or no row exists). Re-read: if WE already own it
          // (a prior attempt of this same retried commit won the claim but
          // died before inserting the marker below), heal by proceeding to
          // the marker insert instead of re-failing a legitimately consumed
          // instance.
          const { data: recheck } = await supabaseAdmin
            .from('loyalty_transactions')
            .select('id, metadata')
            .eq('customer_id', customerId)
            .eq('merchant_id', merchantId)
            .eq('type', 'redeem')
            .eq('loyalty_type', 'points')
            .eq('reference_type', 'milestone')
            .eq('reference_id', inst.milestoneId)
            .eq('order_id', targetOrderId)
            .maybeSingle();
          const recheckMeta = (recheck?.metadata as Record<string, unknown> | null) ?? {};
          if (recheck && recheckMeta.consumed_by_order === orderId) {
            claimedPreRowId = recheck.id;
          } else {
            failed.push({ milestoneId: inst.milestoneId, reason: 'pre_redemption_unavailable' });
            continue;
          }
        }

        // Anchor a zero-point marker under the per-instance order key so a
        // retried commit dedups on the fast-path above without re-claiming.
        const { error: markerErr } = await supabaseAdmin.from('loyalty_transactions').insert({
          customer_id: customerId,
          merchant_id: merchantId,
          order_id: milestoneOrderId,
          type: 'redeem',
          loyalty_type: 'points',
          points: 0,
          description: `Milestone pre-redeemed on rewards screen: ${milestone.reward_name ?? ''}`,
          source: 'app',
          reference_type: 'milestone',
          reference_id: inst.milestoneId,
          metadata: { pre_redeem_of: claimedPreRowId, line_key: inst.lineKey, milestone_name: milestone.reward_name ?? '' },
        });
        if (markerErr && (markerErr as { code?: string }).code !== '23505') {
          // The claim stands (points already consumed) — a retry will
          // re-check the ===orderId recheck branch above and heal by
          // re-inserting this marker, so the deduction can't be lost.
          failed.push({ milestoneId: inst.milestoneId, reason: markerErr.message ?? 'marker_insert_failed' });
          continue;
        }
        deduplicated.push(inst.milestoneId);
        continue;
      }

      // ── Keyless instance (identical to today's LOY-2 legacy R1 scan,
      // now CAS'd instead of read-then-unconditional-update). Excludes any
      // row this order's keyed instances already targeted so one order's
      // keyed and keyless instances of the SAME milestone can't collide.
      //
      // Deliberately UNBOUNDED (no .limit here) — this must scan the exact
      // same keyless-spare candidate set as the authorize gate
      // (authorizeRewardInstancesForCommit's `reference_id.in.(keylessMids)`
      // OR-clause, loyalty.ts ~2253-2269), which has no limit/order at all.
      // A prior version capped this at .limit(25), which let the gate
      // authorize off a spare row outside consume's top-25 window: the gate
      // would say "covered by a spare" (no balance needed) while consume
      // couldn't see that row and fell through to redeem_loyalty_points,
      // charging a FRESH balance deduction for an already-authorized
      // instance (double-charge, or a free item if the balance was
      // insufficient). Active un-consumed pre-redemption spares per
      // customer/milestone are few (bounded by how many times a customer
      // can pre-redeem faster than they check out), so an unbounded scan
      // here is cheap and safe. `.order('created_at', {ascending:false})`
      // is kept so the CAS loop below still prefers the most recent spare
      // first when multiple exist. ──
      const { data: preRows } = await supabaseAdmin
        .from('loyalty_transactions')
        .select('id, order_id, metadata')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId)
        .eq('type', 'redeem')
        .eq('loyalty_type', 'points')
        .eq('reference_type', 'milestone')
        .eq('reference_id', inst.milestoneId)
        .like('order_id', 'milestone-redeem:%')
        .order('created_at', { ascending: false });
      const candidates = (preRows ?? []).filter((r: { order_id: string; metadata?: Record<string, unknown> | null }) => {
        if (keyedTargetOrderIds.has(r.order_id)) return false;
        const meta = (r.metadata ?? {}) as { refunded_at?: unknown; consumed_by_order?: unknown };
        return !meta.refunded_at && !meta.consumed_by_order;
      }) as Array<{ id: string; order_id: string; metadata?: Record<string, unknown> | null }>;

      let claimedSpareId: string | null = null;
      for (const cand of candidates) {
        const priorMeta = (cand.metadata as Record<string, unknown> | null) ?? {};
        const { data: claimRows } = await supabaseAdmin
          .from('loyalty_transactions')
          .update({
            metadata: { ...priorMeta, consumed_by_order: orderId, consumed_at: new Date().toISOString() },
          })
          .eq('id', cand.id)
          .is('metadata->>consumed_by_order', null)
          .is('metadata->>refunded_at', null)
          .select('id');
        if (claimRows && claimRows.length === 1) { claimedSpareId = claimRows[0].id; break; }
        // Lost the CAS on this candidate (claimed by a concurrent commit
        // between our scan and our update) — fall through and try the next.
      }

      if (claimedSpareId) {
        const { error: markerErr } = await supabaseAdmin.from('loyalty_transactions').insert({
          customer_id: customerId,
          merchant_id: merchantId,
          order_id: milestoneOrderId,
          type: 'redeem',
          loyalty_type: 'points',
          points: 0,
          description: `Milestone pre-redeemed on rewards screen: ${milestone.reward_name ?? ''}`,
          source: 'app',
          reference_type: 'milestone',
          reference_id: inst.milestoneId,
          metadata: { pre_redeem_of: claimedSpareId, milestone_name: milestone.reward_name ?? '' },
        });
        if (markerErr && (markerErr as { code?: string }).code !== '23505') {
          failed.push({ milestoneId: inst.milestoneId, reason: markerErr.message ?? 'marker_insert_failed' });
          continue;
        }
        deduplicated.push(inst.milestoneId);
        continue;
      }

      // LOY-10: no spare pre-redemption — atomic deduct + ledger insert in
      // one SECURITY DEFINER call (no crash window where the ledger row
      // exists but the balance never dropped).
      const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('redeem_loyalty_points', {
        p_customer_id: customerId,
        p_merchant_id: merchantId,
        p_points: threshold,
        p_order_id: milestoneOrderId,
        p_reference_type: 'milestone',
        p_reference_id: inst.milestoneId,
        p_source: 'app',
        p_description: `Redeemed milestone: ${milestone.reward_name ?? ''}`,
        p_program_id: null,
        p_metadata: { milestone_id: inst.milestoneId, milestone_name: milestone.reward_name ?? null },
      });
      if (rpcErr) {
        if ((rpcErr as { code?: string }).code === '23505') { deduplicated.push(inst.milestoneId); continue; }
        failed.push({ milestoneId: inst.milestoneId, reason: rpcErr.message ?? 'rpc_failed' });
        continue;
      }
      const status = rpcResultObject(rpcData)?.status;
      if (status === 'duplicate') { deduplicated.push(inst.milestoneId); continue; }
      if (status === 'insufficient') { failed.push({ milestoneId: inst.milestoneId, reason: 'insufficient_points' }); continue; }
      redeemed.push(inst.milestoneId);
    } catch (e: any) {
      failed.push({ milestoneId: inst.milestoneId, reason: e?.message ?? 'error' });
    }
  }

  if (redeemed.length > 0) notifyPassUpdateSafe(customerId, merchantId);
  return { redeemed, deduplicated, failed };
}

/**
 * Pre-charge authorization check for a single reward-milestone cart line —
 * called from orders.ts /commit BEFORE either commit's side effects (the
 * draft commit runs before the card charge), so an unauthorized reward is
 * rejected before money moves. This REPLACES the blanket Phase A 409 once
 * REWARD_CHECKOUT_ENABLED=true (see orderFinalizationGuard.ts).
 *
 * Mirrors consumeOrderMilestones' own R0 (idempotent re-commit) and R1
 * (active pre-redemption from the rewards screen) fast-paths, plus a fresh
 * balance check (R2). Keep the three fast-paths in sync with
 * consumeOrderMilestones if either changes.
 *
 * Product binding is enforced on every fresh (non-R0-retry) path, R1
 * included, and it reads the LIVE loyalty_milestones.foodics_product_ids —
 * not a snapshot taken at pre-redemption time. This is deliberate: skipping
 * binding on R1 would open a wrong-product redemption hole (a cheap
 * pre-redemption claiming an expensive bound product). The honest tradeoff
 * is that a legitimate/pre-redeemed reward is NOT guaranteed to never be
 * false-rejected here — if a merchant edits a milestone's bound products
 * between a customer's pre-redemption and checkout, R1 will be
 * false-rejected for that in-flight cart. That's an accepted, rare race;
 * correct product binding wins over it.
 * TODO: bind against the product recorded at pre-redemption time (e.g.
 * persisted in the pre-redeem transaction's metadata) instead of the live
 * milestone row, so a later merchant edit can't retroactively invalidate an
 * already-pre-redeemed reward.
 */
export async function authorizeRewardMilestoneForCommit(params: {
  customerId: string;
  merchantId: string;
  milestoneId: string;
  foodicsProductId: string | null;
  orderId: string;
}): Promise<{ authorized: true } | { authorized: false; reason: string; error: string }> {
  if (!supabaseAdmin) return { authorized: false, reason: 'no_db', error: 'Database not configured' };
  const { customerId, merchantId, milestoneId, foodicsProductId, orderId } = params;

  // R0: this order already consumed it (idempotent retried commit).
  const milestoneOrderId = `${orderId}:m:${milestoneId}`;
  const { data: priorRedeem } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id')
    .eq('customer_id', customerId)
    .eq('merchant_id', merchantId)
    .eq('order_id', milestoneOrderId)
    .eq('type', 'redeem')
    .maybeSingle();
  if (priorRedeem) return { authorized: true };

  // Milestone must exist, be active, and have a finite positive threshold.
  const { data: milestone } = await supabaseAdmin
    .from('loyalty_milestones')
    .select('id, points_threshold, foodics_product_ids, is_active')
    .eq('id', milestoneId)
    .eq('merchant_id', merchantId)
    .maybeSingle();
  if (!milestone || !milestone.is_active) {
    return { authorized: false, reason: 'milestone_not_found_or_inactive', error: 'This reward is no longer available.' };
  }
  const threshold = Number(milestone.points_threshold);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return { authorized: false, reason: 'invalid_threshold', error: 'This reward is misconfigured.' };
  }

  // Product binding: the cart line's product must be a member of this
  // milestone's foodics_product_ids. An empty array means no reward is
  // configured for this milestone (the client never builds a reward line
  // for one, and preflight forbids an active milestone with an empty
  // array) — reject rather than silently allow.
  const boundProductIds: string[] = Array.isArray(milestone.foodics_product_ids)
    ? milestone.foodics_product_ids
    : [];
  if (boundProductIds.length === 0 || !foodicsProductId || !boundProductIds.includes(foodicsProductId)) {
    return {
      authorized: false,
      reason: 'product_not_bound',
      error: 'This item is not a valid reward for the redeemed milestone.',
    };
  }

  // R1: an active un-consumed pre-redemption exists (rewards-screen flow) —
  // legitimately has points < threshold since it was already spent there.
  const { data: preRows } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id, metadata')
    .eq('customer_id', customerId)
    .eq('merchant_id', merchantId)
    .eq('type', 'redeem')
    .eq('loyalty_type', 'points')
    .eq('reference_type', 'milestone')
    .eq('reference_id', milestoneId)
    .like('order_id', 'milestone-redeem:%')
    .order('created_at', { ascending: false })
    .limit(25);
  const activePre = (preRows ?? []).find((r: { metadata?: Record<string, unknown> | null }) => {
    const meta = (r.metadata ?? {}) as { refunded_at?: unknown; consumed_by_order?: unknown };
    return !meta.refunded_at && !meta.consumed_by_order;
  });
  if (activePre) return { authorized: true };

  // R2: current points balance covers the threshold outright.
  const { data: balanceRow } = await supabaseAdmin
    .from('loyalty_points')
    .select('points')
    .eq('customer_id', customerId)
    .eq('merchant_id', merchantId)
    .maybeSingle();
  const currentPoints = Number(balanceRow?.points ?? 0);
  if (currentPoints >= threshold) return { authorized: true };

  return { authorized: false, reason: 'insufficient_points', error: 'Not enough points for this reward.' };
}

/**
 * Pre-charge authorization gate for a WHOLE cart's reward instances — one
 * call per order (design §3), replacing a per-milestone loop over
 * authorizeRewardMilestoneForCommit. Read-only; batch-loads regardless of
 * instance count N so a stacked cart doesn't cost N round trips.
 *
 * Mirrors consumeOrderMilestones' fast-paths exactly (keep both in sync if
 * either changes):
 *   - R0 retry pass-through: an instance whose order key already has a
 *     redeem/marker row is authorized unconditionally (idempotent re-commit,
 *     even if the milestone was deactivated or the balance since drained).
 *   - Keyed instances must be backed by their OWN exact pre-redemption row
 *     (un-refunded, and un-consumed OR already consumed by this same order —
 *     the 2nd retry pass-through). There is NO balance fallback for a keyed
 *     instance — authorize (or consume) never silently converts a missing
 *     pre-redemption into a fresh live-balance deduction.
 *   - Keyless instances (today's only shape) reuse a SPARE active
 *     pre-redemption for the same milestone if one exists and isn't already
 *     targeted by one of this cart's keyed instances; otherwise they add
 *     their threshold to a SUMMED balance requirement.
 *   - The summed balance check (fixes L4 — old code checked each milestone's
 *     threshold against balance independently in a loop, so
 *     M1(300)+M2(200) at a 350 balance passed the gate and the second
 *     redeem_loyalty_points then failed post-commit, handing out a free
 *     item) is checked ONCE against the total needed across every
 *     balance-backed instance in the cart.
 */
export async function authorizeRewardInstancesForCommit(params: {
  customerId: string;
  merchantId: string;
  orderId: string;
  instances: RewardInstance[];
}): Promise<{ authorized: true } | { authorized: false; reason: string; error: string; milestoneId: string }> {
  if (!supabaseAdmin) return { authorized: false, reason: 'no_db', error: 'Database not configured', milestoneId: '' };
  const { customerId, merchantId, orderId, instances } = params;
  if (instances.length === 0) return { authorized: true };

  const preRedeemOrderId = (mid: string, lineKey: string) => `milestone-redeem:${mid}:${lineKey}`;
  const instanceKeyOf = (inst: RewardInstance) =>
    inst.lineKey != null ? `${orderId}:m:${inst.milestoneId}:k:${inst.lineKey}` : `${orderId}:m:${inst.milestoneId}`;

  const distinctMids = Array.from(new Set(instances.map((i) => i.milestoneId)));
  const keyedInstances = instances.filter((i) => i.lineKey != null);
  const keylessInstances = instances.filter((i) => i.lineKey == null);
  const keyedTargetOrderIds = keyedInstances.map((i) => preRedeemOrderId(i.milestoneId, i.lineKey as string));
  const keylessMids = Array.from(new Set(keylessInstances.map((i) => i.milestoneId)));

  // 1. Batch loads — 3 queries regardless of N (the pre-redemption read
  // covers both the keyed exact-key lookups and the keyless per-milestone
  // spare scan in one request via `.or()`).
  //
  // Candidate-set parity with consumeOrderMilestones (closes the gate-vs-
  // consume mismatch): the keyed half of this OR (`order_id.in.(...)`) is
  // an exact-key lookup — always complete, nothing to bound. The keyless
  // half (`reference_id.in.(keylessMids)`) is intentionally UNBOUNDED (no
  // .order()/.limit()), and consumeOrderMilestones' keyless spare scan
  // (loyalty.ts, "Keyless instance" branch) was widened to match — also
  // unbounded, same filter predicate (unrefunded, unconsumed, not a keyed
  // target of this cart). Gate and consume therefore always see the
  // identical keyless-spare candidate set: the gate can no longer authorize
  // off a spare that consume can't subsequently find and claim.
  const [milestoneRows, markerRows, preRedemptionRows] = await Promise.all([
    supabaseAdmin
      .from('loyalty_milestones')
      .select('id, points_threshold, foodics_product_ids, is_active')
      .eq('merchant_id', merchantId)
      .in('id', distinctMids)
      .then((r) => r.data ?? []),
    supabaseAdmin
      .from('loyalty_transactions')
      .select('order_id')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .eq('type', 'redeem')
      .in('order_id', instances.map(instanceKeyOf))
      .then((r) => r.data ?? []),
    (async () => {
      if (keyedTargetOrderIds.length === 0 && keylessMids.length === 0) return [];
      let q = supabaseAdmin!
        .from('loyalty_transactions')
        .select('id, order_id, reference_id, metadata')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId)
        .eq('type', 'redeem')
        .eq('loyalty_type', 'points')
        .eq('reference_type', 'milestone')
        .like('order_id', 'milestone-redeem:%');
      const orClauses: string[] = [];
      if (keyedTargetOrderIds.length > 0) orClauses.push(`order_id.in.(${keyedTargetOrderIds.join(',')})`);
      if (keylessMids.length > 0) orClauses.push(`reference_id.in.(${keylessMids.join(',')})`);
      const { data } = await q.or(orClauses.join(','));
      return data ?? [];
    })(),
  ]);

  const milestoneById = new Map<string, { id: string; points_threshold: number; foodics_product_ids: string[] | null; is_active: boolean }>();
  for (const m of milestoneRows as Array<{ id: string; points_threshold: number; foodics_product_ids: string[] | null; is_active: boolean }>) {
    milestoneById.set(m.id, m);
  }
  const markerOrderIds = new Set((markerRows as Array<{ order_id: string }>).map((r) => r.order_id));
  const preRows = preRedemptionRows as Array<{ id: string; order_id: string; reference_id: string; metadata: Record<string, unknown> | null }>;
  const preByOrderId = new Map(preRows.map((r) => [r.order_id, r]));
  const keyedTargetSet = new Set(keyedTargetOrderIds);
  const findSparePreRedemption = (mid: string): boolean =>
    preRows.some((r) => {
      if (r.reference_id !== mid) return false;
      if (keyedTargetSet.has(r.order_id)) return false; // reserved for a keyed instance in this cart
      const meta = (r.metadata ?? {}) as { refunded_at?: unknown; consumed_by_order?: unknown };
      return !meta.refunded_at && !meta.consumed_by_order;
    });

  // 2. Per-instance evaluation (all reads — no claiming here).
  let needsBalance = 0;
  for (const inst of instances) {
    if (markerOrderIds.has(instanceKeyOf(inst))) continue; // R0 retry pass-through

    const milestone = milestoneById.get(inst.milestoneId);
    if (!milestone || !milestone.is_active) {
      return { authorized: false, reason: 'milestone_not_found_or_inactive', error: 'This reward is no longer available.', milestoneId: inst.milestoneId };
    }
    const threshold = Number(milestone.points_threshold);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      return { authorized: false, reason: 'invalid_threshold', error: 'This reward is misconfigured.', milestoneId: inst.milestoneId };
    }

    const boundProductIds: string[] = Array.isArray(milestone.foodics_product_ids) ? milestone.foodics_product_ids : [];
    const allBound = boundProductIds.length > 0 && inst.fids.length > 0 && inst.fids.every((fid) => boundProductIds.includes(fid));
    if (!allBound) {
      return { authorized: false, reason: 'product_not_bound', error: 'This item is not a valid reward for the redeemed milestone.', milestoneId: inst.milestoneId };
    }

    if (inst.lineKey != null) {
      // Keyed instance: exact pre-redemption row required. No balance fallback.
      const row = preByOrderId.get(preRedeemOrderId(inst.milestoneId, inst.lineKey));
      const meta = (row?.metadata ?? {}) as { refunded_at?: unknown; consumed_by_order?: unknown };
      const ok = !!row && !meta.refunded_at && (!meta.consumed_by_order || meta.consumed_by_order === orderId);
      if (!ok) {
        return { authorized: false, reason: 'pre_redemption_unavailable', error: 'This pre-redeemed reward is no longer available.', milestoneId: inst.milestoneId };
      }
      continue;
    }

    // Keyless instance: a spare active pre-redemption covers it, else it
    // needs headroom in the summed balance check below.
    if (findSparePreRedemption(inst.milestoneId)) continue;
    needsBalance += threshold;
  }

  // 3. Summed balance check (fixes L4) — one read, checked against the
  // TOTAL across every balance-backed instance in the cart.
  if (needsBalance > 0) {
    const { data: balanceRow } = await supabaseAdmin
      .from('loyalty_points')
      .select('points')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .maybeSingle();
    const currentPoints = Number(balanceRow?.points ?? 0);
    if (currentPoints < needsBalance) {
      return { authorized: false, reason: 'insufficient_points', error: 'Not enough points for this reward.', milestoneId: '' };
    }
  }

  return { authorized: true };
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

  // consumeOrderMilestones now namespaces each milestone redeem under
  // `<orderId>:m:<mid>` (LOY-2/LOY-10) so the per-order unique index can dedup
  // per-milestone. Match both the composite rows AND any legacy rows keyed on
  // the bare orderId with a prefix LIKE. order ids are UUIDs (never a prefix of
  // one another) so this can't leak across orders; zero-point pre-redemption
  // markers fall out via the `giveBack <= 0` skip below.
  const { data: redeems } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id, reference_id, points')
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId)
    .like('order_id', `${params.orderId}%`)
    .eq('type', 'redeem')
    .eq('reference_type', 'milestone');
  // NOTE: no early-return-on-empty here. Pre-redeemed (rewards-screen)
  // instances that a later commit CONSUMED live under order_id
  // `milestone-redeem:<mid>:<key>` — never under `<orderId>%` — so an order
  // that ONLY had pre-redeemed rewards would find zero rows here and, with
  // an early return, never reach the 2nd pass below (closes L3).

  for (const row of (redeems ?? []) as Array<{ id: string; reference_id: string; points: number }>) {
    // Idempotency (defect-4 fix): scope the dedup check to the EXACT
    // idempotency_key this 1st-pass row would produce
    // (`refund:order:<orderId>:<reference_id>`), not just (order_id,
    // reference_id). Under stacking, the 2nd pass below inserts ONE
    // earn/milestone-refund row PER consumed keyed pre-redemption instance
    // — same order_id, same reference_id (the milestone id), but its OWN
    // distinct idempotency_key `refund:order:<orderId>:pre:<preRowId>`. So
    // once an order has consumed 2+ keyed instances of one milestone, 2+
    // rows can legitimately share (order_id, reference_id). The OLD
    // `.eq('reference_id', ...).maybeSingle()` query matched ALL of them
    // and, on a retry of this whole function after the 2nd pass had
    // already run once, PostgREST errors on "multiple rows returned" —
    // `.maybeSingle()` then resolves to `data: null` (the destructure
    // above never checked `error`), so `priorRestore` read as "not yet
    // restored" and this 1st-pass row got double-credited.
    //
    // Filtering on the exact idempotency_key instead of the raw
    // (order_id, reference_id) pair is also NOT the same as a blanket
    // existence check on (order_id, reference_id, type, reference_type) —
    // a blanket check would find a 2nd-pass row for the SAME reference_id
    // and wrongly conclude this DIFFERENT (1st-pass) deduction was already
    // restored, silently skipping a legitimate refund (a customer loss in
    // the other direction). Matching the exact key means this check only
    // ever matches a row this exact 1st-pass source row itself previously
    // created — `.limit(1)` (not `.maybeSingle()`) so it can never error
    // even if some future bug produced duplicates, preserving
    // exactly-once restore per source row without a false-skip risk.
    const priorRestoreKey = `refund:order:${params.orderId}:${row.reference_id}`;
    const { data: priorRestoreRows } = await supabaseAdmin
      .from('loyalty_transactions')
      .select('id')
      .eq('customer_id', params.customerId)
      .eq('merchant_id', params.merchantId)
      .eq('order_id', params.orderId)
      .eq('type', 'earn')
      .eq('reference_type', 'milestone-refund')
      .eq('reference_id', row.reference_id)
      .eq('metadata->>idempotency_key', priorRestoreKey)
      .limit(1);
    if (priorRestoreRows && priorRestoreRows.length > 0) { anyAlready = true; cleared.push(String(row.reference_id)); continue; }

    const giveBack = Math.abs(Number(row.points) || 0);
    if (giveBack <= 0) continue;

    // Atomic + idempotent ledger-insert + balance-credit via
    // refund_loyalty_points, keyed on the SAME priorRestoreKey the fast
    // prior-check above uses — a crash between the old separate
    // increment_loyalty_points call and ledger insert could double-credit
    // (retry re-increments) or (in the other order) silently lose the
    // credit; this RPC does both in one DB transaction, idempotent on
    // p_order_id, so a retry/resume can never do either.
    const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('refund_loyalty_points', {
      p_customer_id: params.customerId,
      p_merchant_id: params.merchantId,
      p_points: giveBack,
      p_order_id: priorRestoreKey,
      p_reference_type: 'milestone_refund',
      p_reference_id: row.reference_id,
      p_source: 'refund',
      p_description: 'Refunded milestone (order cancelled)',
      p_metadata: { idempotency_key: priorRestoreKey },
    });
    if (rpcErr) { console.warn('[restoreMilestones] refund_loyalty_points failed:', rpcErr.message); continue; }
    const rpcResult = rpcResultObject(rpcData);
    if (rpcResult?.status === 'duplicate') {
      anyAlready = true;
    } else {
      pointsRestored += giveBack;
    }
    cleared.push(String(row.reference_id));
  }

  // ── 2nd pass (design §8, closes L3): restore CONSUMED pre-redemptions.
  // consumeOrderMilestones claims a rewards-screen pre-redemption by setting
  // metadata.consumed_by_order = orderId on the ORIGINAL `milestone-redeem:
  // <mid>:<key>` row — it never creates a 2nd row under this order's own id
  // for that deduction (only a 0-point marker, skipped above via the
  // `giveBack <= 0` guard). Without this pass, cancelling an order that
  // consumed a pre-redemption never gave the points back — a real customer
  // loss. Per-instance CAS (not the 1st pass's per-reference_id prior-restore
  // check) so a SECOND instance of the same milestone in the same order
  // restores independently instead of being skipped as "already restored".
  const { data: consumedPre } = await supabaseAdmin
    .from('loyalty_transactions')
    .select('id, reference_id, points, metadata')
    .eq('customer_id', params.customerId)
    .eq('merchant_id', params.merchantId)
    .eq('type', 'redeem')
    .eq('loyalty_type', 'points')
    .eq('reference_type', 'milestone')
    .like('order_id', 'milestone-redeem:%')
    .eq('metadata->>consumed_by_order', params.orderId);

  for (const row of (consumedPre ?? []) as Array<{ id: string; reference_id: string; points: number; metadata: Record<string, unknown> | null }>) {
    const giveBack = Math.abs(Number(row.points) || 0);
    if (giveBack <= 0) continue;

    // CAS: the WHERE clause (re-evaluated under row lock at UPDATE time) is
    // the idempotency guard — only the first restore attempt for this exact
    // pre-redemption row can win it. Do NOT clear consumed_by_order;
    // refunded_at alone makes the row permanently unclaimable by both a
    // future consume (loyalty.ts CAS requires refunded_at IS NULL) and a
    // future unredeem (handleUnredeemMilestone's L1 CAS, same guard).
    const priorMeta = (row.metadata as Record<string, unknown> | null) ?? {};
    const { data: claimRows } = await supabaseAdmin
      .from('loyalty_transactions')
      .update({
        metadata: { ...priorMeta, refunded_at: new Date().toISOString(), refund_reason: 'order_cancelled' },
      })
      .eq('id', row.id)
      .is('metadata->>refunded_at', null)
      .select('id');
    const wonCas = !!claimRows && claimRows.length === 1;
    // CRASH-WINDOW FIX: a lost CAS here does NOT necessarily mean this row
    // was already fully restored — it can also mean a PRIOR attempt of
    // THIS SAME restore won the CAS (marked refunded_at) and then crashed
    // before crediting, which under the old separate
    // increment_loyalty_points + ledger-insert would have silently lost the
    // credit forever (nothing ever re-examined a refunded_at-set row). A
    // `consumed_by_order = orderId` row can only be refunded by THIS
    // order's cancellation, so a lost CAS here is always a prior attempt of
    // this very restore — never a different, unrelated writer. Because
    // refund_loyalty_points is idempotent on p_order_id, calling it below
    // regardless of who won the CAS safely COMPLETES an interrupted credit
    // on a lost CAS (status 'ok') or is a pure no-op if it was already
    // fully completed (status 'duplicate') — never a double-credit.
    const preRefundOrderId = `refund:order:${params.orderId}:pre:${row.id}`;
    const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('refund_loyalty_points', {
      p_customer_id: params.customerId,
      p_merchant_id: params.merchantId,
      p_points: giveBack,
      p_order_id: preRefundOrderId,
      p_reference_type: 'milestone_refund',
      p_reference_id: row.reference_id,
      p_source: 'refund',
      p_description: 'Refunded consumed pre-redemption (order cancelled)',
      p_metadata: { idempotency_key: preRefundOrderId },
    });
    if (rpcErr) {
      console.warn('[restoreMilestones] refund_loyalty_points failed (pre-redemption):', rpcErr.message);
      if (!wonCas) anyAlready = true;
      continue;
    }
    const rpcResult = rpcResultObject(rpcData);
    if (rpcResult?.status === 'duplicate') {
      anyAlready = true;
    } else {
      pointsRestored += giveBack;
      if (!cleared.includes(String(row.reference_id))) cleared.push(String(row.reference_id));
    }
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

    // LOY-1: atomic deduct + ledger via redeem_loyalty_cashback. Replaces the
    // read-modify-write `.gte()` update + separate insert with one SECURITY
    // DEFINER call that guards `balance_sar >= amount` and inserts the redeem
    // row under the partial unique index idx_loyalty_tx_cashback_redeem_per_order
    // — closing both the double-spend race and the check-then-insert window that
    // could slip past the priorRedeem fast-path above. p_config_version pins the
    // ledger row (and the balance row targeted) to the same version the balance
    // read resolved, matching the prior behavior.
    const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('redeem_loyalty_cashback', {
      p_customer_id: customerId,
      p_merchant_id: merchantId,
      p_amount_sar: amount,
      p_order_id: orderId,
      p_reference_type: null,
      p_reference_id: null,
      p_source: 'app',
      p_description: `Used ${amount} SAR cashback`,
      p_config_version: balRow?.config_version ?? config.config_version ?? null,
    });
    if (rpcErr) return res.status(500).json({ error: rpcErr.message });
    const rpcResult = rpcResultObject(rpcData);
    const status = rpcResult?.status;
    const rpcNewBalance = rpcResult?.new_balance_sar;
    if (status === 'insufficient') {
      return res.status(400).json({ error: `Insufficient cashback. Available: ${balance} SAR` });
    }
    if (status === 'duplicate') {
      // Same order already redeemed (race-loser past the fast-path) — return the
      // prior redemption idempotently, matching the existing deduplicated shape.
      return res.json({
        success: true,
        amountRedeemed: amount,
        newBalance: rpcNewBalance != null ? +Number(rpcNewBalance).toFixed(2) : null,
        deduplicated: true,
      });
    }

    notifyPassUpdateSafe(customerId, merchantId);
    res.json({
      success: true,
      amountRedeemed: amount,
      newBalance: rpcNewBalance != null ? +Number(rpcNewBalance).toFixed(2) : +(balance - amount).toFixed(2),
    });
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

    // ─── Read current balance (for the informative not-enough-points 400) ───
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

    // ─── Atomic deduct + ledger via redeem_loyalty_points (LOY-10) ───
    // order_id encodes the idempotencyKey, so a retry with the same key dedups
    // on the A4 per-order unique index. The SECURITY DEFINER RPC does
    // INSERT-then-UPDATE in one transaction (no crash window where the ledger
    // row exists but the balance never dropped) and returns {status} — a
    // race-loser comes back as {status:'duplicate'} rather than raising 23505
    // to a 500 (LOY-15). Idempotency here replaces the old 24h metadata scan.
    const redeemOrderId = `milestone-redeem:${milestoneId}:${idempotencyKey}`;
    const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('redeem_loyalty_points', {
      p_customer_id: customerId,
      p_merchant_id: merchantId,
      p_points: pointsThreshold,
      p_order_id: redeemOrderId,
      p_reference_type: 'milestone',
      p_reference_id: milestoneId,
      p_source: 'app',
      p_description: `Redeemed milestone: ${milestone.reward_name ?? ''}`,
      p_program_id: null,
      p_metadata: { milestone_id: milestoneId, milestone_name: milestone.reward_name ?? null, idempotency_key: idempotencyKey },
    });
    const rpcResult = rpcResultObject(rpcData);
    const status = rpcResult?.status;
    // LOY-15: treat a duplicate (status or a re-raised 23505) as a
    // deduplicated success, not a 500.
    const isDuplicate = status === 'duplicate' || (rpcErr as { code?: string } | null)?.code === '23505';
    if (rpcErr && !isDuplicate) {
      return res.status(500).json({ error: rpcErr.message || 'Failed to record redemption' });
    }
    if (status === 'insufficient') {
      return res.status(400).json({
        error: 'Not enough points',
        needed: pointsThreshold,
        current: currentPoints,
      });
    }

    // redemptionId is load-bearing — the app passes it to /unredeem-milestone
    // to refund on cart removal. The RPC returns only {status,new_balance}, so
    // resolve the redeem row by its unique order_id.
    const { data: redeemRow } = await supabaseAdmin
      .from('loyalty_transactions')
      .select('id')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .eq('order_id', redeemOrderId)
      .eq('type', 'redeem')
      .maybeSingle();

    let newBalance = rpcResult?.new_balance;
    if (newBalance == null) {
      const { data: bal } = await supabaseAdmin
        .from('loyalty_points')
        .select('points')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId)
        .maybeSingle();
      newBalance = bal?.points ?? 0;
    }

    notifyPassUpdateSafe(customerId, merchantId);

    return res.json({
      success: true,
      newBalance,
      redemptionId: redeemRow?.id ?? null,
      milestoneRewardName: milestone.reward_name ?? '',
      foodicsProductIds: milestone.foodics_product_ids ?? [],
      ...(isDuplicate ? { deduplicated: true } : {}),
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

    // Idempotency: if we already refunded this redemption, FINISH the
    // refund (see finishRefund below) rather than blindly reporting
    // success. Lets the cart-context fire the refund call multiple times
    // safely (e.g. on every remove → re-add → remove cycle) AND recovers a
    // refund an earlier process crashed in the middle of.
    const originalMeta = (original.metadata as Record<string, unknown> | null) ?? {};
    const referenceId = String(original.reference_id ?? '');
    // Points value is negative on a redeem row; abs() to add back. Moved
    // up (was previously computed after the guards below) — the
    // refunded_at resume path needs it even when short-circuiting past
    // those guards, since a prior attempt already cleared them to win the
    // CAS.
    const pointsToRefund = Math.abs(Number(original.points ?? 0));

    // Defect-3 crash-window fix: completes the SECOND half of a refund
    // (idempotent ledger insert + balance credit + audit log) for a row
    // whose metadata.refunded_at is already set — either because the CAS
    // below just won it, or because an EARLIER call/process won that same
    // CAS and then errored or crashed before finishing. Called from all
    // three sites where we observe refunded_at already set.
    //
    // Why this can't double-credit: the ledger row inserted here uses
    // order_id `milestone-refund:<redemptionId>`, which falls under the
    // SAME partial unique index that dedups redeem rows
    // (idx_loyalty_tx_points_redeem_per_order on (merchant_id,
    // customer_id, order_id) WHERE type='redeem' AND
    // loyalty_type='points'), so a second insert attempt for the same
    // redemptionId always 23505s. The balance credit only ever runs in the
    // branch where THIS call's own insert created the row — never on a
    // 23505 — so across the original attempt plus any number of retries
    // resumes/concurrent duplicate calls, the credit fires at most once.
    // Why this can't silently lose the credit: previously ANY crash
    // between the CAS (refunded_at set) and the old inline ledger-insert
    // +credit permanently stuck the row on the refunded_at dedup fast-path
    // forever, since nothing ever re-examined it. Now that fast-path calls
    // finishRefund, which re-attempts the refund; since no ledger row
    // exists yet for that crash case, the insert succeeds fresh and the
    // credit runs. The ledger insert and the balance credit are no longer
    // two separate writes either — refund_loyalty_points does both in ONE
    // transaction, so there is no window in which a kill can leave a ledger
    // row with no credit. Every crash point is recoverable, with neither a
    // double-credit nor a silent loss.
    const finishRefund = async (meta: Record<string, unknown>) => {
      if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });

      // Atomic + idempotent ledger-insert + balance-credit via the
      // refund_loyalty_points RPC (SECURITY DEFINER, one DB transaction).
      // Idempotency key = order_id `milestone-refund:<redemptionId>` — same
      // value the old manual insert used, and it falls under the same
      // partial unique index redeem_loyalty_points relies on, so a repeat
      // call (retry, crash-recovery resume, or a concurrent duplicate) is
      // guaranteed to credit at most once, and can never silently lose the
      // credit either — insert and credit happen together or not at all.
      const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('refund_loyalty_points', {
        p_customer_id: customerId,
        p_merchant_id: merchantId,
        p_points: pointsToRefund,
        p_order_id: `milestone-refund:${redemptionId}`,
        p_reference_type: 'milestone_refund',
        p_reference_id: referenceId,
        p_source: 'app',
        p_description: 'Refund: reward removed from cart',
        p_metadata: {
          refund_of: redemptionId,
          original_milestone_id: referenceId,
        },
      });
      if (rpcErr) {
        // Real failure — refunded_at stays set on the original row, so the
        // next retry re-enters this same finishRefund path and tries the
        // RPC again instead of silently reporting success. No credit has
        // happened yet.
        return res.status(500).json({ error: rpcErr.message || 'Refund failed' });
      }
      const rpcResult = rpcResultObject(rpcData);
      const rpcStatus = rpcResult?.status;
      const newBalance = Number(rpcResult?.new_balance ?? 0);
      const transactionId = rpcResult?.transaction_id as string | undefined;

      // Attach the refund transaction id onto the original's metadata.
      // Best-effort follow-up write (not a CAS, not load-bearing) — the
      // RPC's ledger row plus refunded_at above are the durable truth.
      await supabaseAdmin
        .from('loyalty_transactions')
        .update({
          metadata: {
            ...meta,
            refunded_at: (meta.refunded_at as string | undefined) ?? new Date().toISOString(),
            ...(transactionId ? { refund_transaction_id: transactionId } : {}),
          },
        })
        .eq('id', redemptionId);

      // Audit log
      await supabaseAdmin.from('audit_log').insert({
        merchant_id: merchantId,
        action: 'loyalty.milestone_refunded',
        payload: {
          customer_id: customerId,
          redemption_id: redemptionId,
          refund_transaction_id: transactionId ?? null,
          points_refunded: pointsToRefund,
          reason: 'cart_removal',
        },
      });

      return res.json({
        success: true,
        deduplicated: rpcStatus === 'duplicate',
        pointsRefunded: pointsToRefund,
        newBalance,
      });
    };

    if (originalMeta.refunded_at) {
      return finishRefund(originalMeta);
    }

    // L1 fix (design §8, closes a LIVE exploit): reject if a real order
    // already consumed this pre-redemption. Before this check, the ONLY
    // "already completed" guard was the completedOrder lookup below, keyed
    // off `original.order_id` — but for a rewards-screen pre-redemption,
    // `original.order_id` IS the `milestone-redeem:<mid>:<key>` row itself
    // (never a customer_orders id), so that lookup always no-ops for this
    // row shape. That let redeem → checkout (goods committed, and
    // consumeOrderMilestones marks metadata.consumed_by_order on this exact
    // row) → /unredeem-milestone hand back points for an already-delivered
    // reward. metadata.consumed_by_order is the real signal that this
    // pre-redemption was spent by an order.
    if (originalMeta.consumed_by_order) {
      return res.status(409).json({ error: 'Reward already used in an order' });
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

    if (pointsToRefund === 0) {
      return res.status(400).json({ error: 'Original redemption has zero points' });
    }

    const nowIso = new Date().toISOString();

    // 1. CAS-claim FIRST (design §8, closes L2-style unredeem/consume race).
    //    The two reads above (refunded_at, consumed_by_order) are fast-path
    //    checks only — this conditional UPDATE's WHERE clause is the actual
    //    guard, re-evaluated by Postgres under row lock at write time. It is
    //    mutually exclusive with consumeOrderMilestones' own claim CAS
    //    (which requires metadata->>refunded_at IS NULL): whichever writer
    //    reaches the row first under the lock wins, and the loser's WHERE
    //    clause simply stops matching. This closes the race where a
    //    concurrent commit consumes the reward at the same instant a
    //    duplicate unredeem call refunds it.
    const { data: claimRows, error: claimErr } = await supabaseAdmin
      .from('loyalty_transactions')
      .update({ metadata: { ...originalMeta, refunded_at: nowIso } })
      .eq('id', redemptionId)
      .is('metadata->>refunded_at', null)
      .is('metadata->>consumed_by_order', null)
      .select('id');
    if (claimErr) {
      return res.status(500).json({ error: claimErr.message || 'Failed to claim redemption for refund' });
    }
    if (!claimRows || claimRows.length !== 1) {
      // Lost the CAS between our reads above and this write — re-read to
      // report the correct terminal state instead of guessing.
      const { data: recheck } = await supabaseAdmin
        .from('loyalty_transactions')
        .select('metadata')
        .eq('id', redemptionId)
        .maybeSingle();
      const recheckMeta = (recheck?.metadata as Record<string, unknown> | null) ?? {};
      if (recheckMeta.refunded_at) {
        return finishRefund(recheckMeta);
      }
      if (recheckMeta.consumed_by_order) {
        return res.status(409).json({ error: 'Reward already used in an order' });
      }
      return res.status(500).json({ error: 'Failed to claim redemption for refund' });
    }

    // 2-5. Ledger insert + attach id + balance credit + audit log, via the
    // same resumable finishRefund used by the retry/crash-recovery paths
    // above — we just won the CAS, so this is the "fresh" call that will
    // actually create the ledger row and perform the credit.
    return finishRefund({ ...originalMeta, refunded_at: nowIso });
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
