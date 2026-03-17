/**
 * Loyalty routes – merchant-config-driven points, stamps, rewards, and wallet pass
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { notifyPassUpdate } from './walletPass';

export const loyaltyRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const DEFAULT_CONFIG = {
  earn_mode: 'per_sar' as const,
  points_per_sar: 0.1,
  points_per_order: 10,
  point_value_sar: 0.1,
  expiry_months: null as number | null,
  stamp_enabled: false,
  stamp_target: 10,
  stamp_reward_description: 'Free item',
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
    const { merchantId, ...fields } = req.body;
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const allowed = [
      'earn_mode', 'points_per_sar', 'points_per_order', 'point_value_sar',
      'expiry_months', 'stamp_enabled', 'stamp_target', 'stamp_reward_description',
      'wallet_card_bg_color', 'wallet_card_text_color', 'wallet_card_logo_url',
      'wallet_card_label', 'wallet_card_secondary_label',
    ];
    const payload: Record<string, unknown> = { merchant_id: merchantId, updated_at: new Date().toISOString() };
    for (const k of allowed) {
      if (k in fields) payload[k] = fields[k];
    }

    console.log('[loyalty] PUT config payload:', JSON.stringify(payload));
    const { data, error } = await supabaseAdmin
      .from('loyalty_config')
      .upsert(payload, { onConflict: 'merchant_id' })
      .select();
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
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

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

    let stamps = 0;
    let completedCards = 0;
    if (config.stamp_enabled && merchantId) {
      const { data: stampData } = await supabaseAdmin
        .from('loyalty_stamps')
        .select('stamps, completed_cards')
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId)
        .single();
      stamps = stampData?.stamps ?? 0;
      completedCards = stampData?.completed_cards ?? 0;
    }

    res.json({
      points,
      lifetimePoints,
      pointsValue,
      pointsPerSar: config.points_per_sar,
      pointsPerOrder: config.points_per_order,
      pointValueSar: config.point_value_sar,
      earnMode: config.earn_mode,
      expiryMonths: config.expiry_months,
      stampEnabled: config.stamp_enabled,
      stampTarget: config.stamp_target,
      stampRewardDescription: config.stamp_reward_description,
      stamps,
      completedCards,
      walletCardBgColor: config.wallet_card_bg_color || null,
      walletCardTextColor: config.wallet_card_text_color || null,
      walletCardLogoUrl: config.wallet_card_logo_url || null,
      walletCardLabel: config.wallet_card_label || null,
      walletCardSecondaryLabel: config.wallet_card_secondary_label || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get loyalty balance' });
  }
});

/* ── POST /api/loyalty/earn ── */
loyaltyRouter.post('/earn', async (req, res) => {
  try {
    const { customerId, orderId, orderSubtotal, merchantId } = req.body;
    if (!customerId || !orderId || orderSubtotal == null) {
      return res.status(400).json({ error: 'customerId, orderId, and orderSubtotal required' });
    }
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const result = await earnPoints(customerId, orderId, Number(orderSubtotal), merchantId || '');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to earn points' });
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
): Promise<{ success: boolean; pointsEarned: number; newBalance: number; stampAwarded?: boolean; stampRewardGranted?: boolean }> {
  if (!supabaseAdmin) throw new Error('Database not configured');
  const config = await getMerchantConfig(merchantId);

  const pointsEarned = config.earn_mode === 'per_order'
    ? Math.floor(config.points_per_order)
    : Math.floor(orderSubtotal * config.points_per_sar);

  const expiresAt = config.expiry_months
    ? new Date(Date.now() + config.expiry_months * 30 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const { data: existing } = await supabaseAdmin
    .from('loyalty_points')
    .select('points, lifetime_points')
    .eq('customer_id', customerId)
    .eq('merchant_id', merchantId)
    .single();

  if (existing) {
    await supabaseAdmin
      .from('loyalty_points')
      .update({
        points: existing.points + pointsEarned,
        lifetime_points: existing.lifetime_points + pointsEarned,
        updated_at: new Date().toISOString(),
      })
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId);
  } else {
    await supabaseAdmin.from('loyalty_points').insert({
      customer_id: customerId,
      merchant_id: merchantId,
      points: pointsEarned,
      lifetime_points: pointsEarned,
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
  });

  let stampAwarded = false;
  let stampRewardGranted = false;
  if (config.stamp_enabled && merchantId) {
    const { data: stampRow } = await supabaseAdmin
      .from('loyalty_stamps')
      .select('stamps, completed_cards')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .single();

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
      });
    }

    if (stampRow) {
      await supabaseAdmin
        .from('loyalty_stamps')
        .update({ stamps: newStamps, completed_cards: completedCards, updated_at: new Date().toISOString() })
        .eq('customer_id', customerId)
        .eq('merchant_id', merchantId);
    } else {
      await supabaseAdmin.from('loyalty_stamps').insert({
        customer_id: customerId,
        merchant_id: merchantId,
        stamps: newStamps,
        completed_cards: completedCards,
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
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const config = await getMerchantConfig(merchantId || '');
    const pointsToRedeem = Math.floor(Number(points));
    if (pointsToRedeem <= 0) return res.status(400).json({ error: 'Invalid points amount' });

    const { data: balance } = await supabaseAdmin
      .from('loyalty_points')
      .select('points')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId || '')
      .single();

    if (!balance || balance.points < pointsToRedeem) {
      return res.status(400).json({ error: 'Insufficient points', available: balance?.points ?? 0 });
    }

    const discountSar = +(pointsToRedeem * config.point_value_sar).toFixed(2);

    await supabaseAdmin
      .from('loyalty_points')
      .update({ points: balance.points - pointsToRedeem, updated_at: new Date().toISOString() })
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId || '');

    await supabaseAdmin.from('loyalty_transactions').insert({
      customer_id: customerId,
      merchant_id: merchantId || '',
      order_id: orderId,
      type: 'redeem',
      points: -pointsToRedeem,
      description: `Redeemed ${pointsToRedeem} points for ${discountSar} SAR discount`,
    });

    notifyPassUpdate(customerId, merchantId || '').catch(() => {});
    res.json({ success: true, pointsRedeemed: pointsToRedeem, discountSar, newBalance: balance.points - pointsToRedeem });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to redeem points' });
  }
});

/* ── POST /api/loyalty/redeem-reward ── */
loyaltyRouter.post('/redeem-reward', async (req, res) => {
  try {
    const { customerId, rewardId, merchantId } = req.body;
    if (!customerId || !rewardId) return res.status(400).json({ error: 'customerId and rewardId required' });
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: reward } = await supabaseAdmin
      .from('loyalty_rewards')
      .select('*')
      .eq('id', rewardId)
      .eq('is_active', true)
      .single();
    if (!reward) return res.status(404).json({ error: 'Reward not found or inactive' });

    const { data: balance } = await supabaseAdmin
      .from('loyalty_points')
      .select('points')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId || reward.merchant_id)
      .single();

    if (!balance || balance.points < reward.points_cost) {
      return res.status(400).json({ error: 'Insufficient points', needed: reward.points_cost, available: balance?.points ?? 0 });
    }

    await supabaseAdmin
      .from('loyalty_points')
      .update({ points: balance.points - reward.points_cost, updated_at: new Date().toISOString() })
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId || reward.merchant_id);

    await supabaseAdmin.from('loyalty_transactions').insert({
      customer_id: customerId,
      merchant_id: merchantId || reward.merchant_id,
      type: 'redeem',
      points: -reward.points_cost,
      description: `Redeemed reward: ${reward.name}`,
    });

    notifyPassUpdate(customerId, merchantId || reward.merchant_id).catch(() => {});
    res.json({ success: true, reward: reward.name, pointsSpent: reward.points_cost, newBalance: balance.points - reward.points_cost });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to redeem reward' });
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
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });
    const { error } = await supabaseAdmin.from('loyalty_rewards').update({ is_active: false }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to delete reward' });
  }
});

/* ── GET /api/loyalty/history?customerId=X&merchantId=X ── */
loyaltyRouter.get('/history', async (req, res) => {
  try {
    const customerId = req.query.customerId as string;
    const merchantId = req.query.merchantId as string;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
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
