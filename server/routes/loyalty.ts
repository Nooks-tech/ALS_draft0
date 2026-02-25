/**
 * Loyalty routes – wraps Foodics loyalty endpoints + local points tracking
 * Foodics loyalty: points earned per order, redeemable at checkout
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';

export const loyaltyRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FOODICS_BASE = process.env.FOODICS_API_URL || 'https://api.foodics.com/v5';
const FOODICS_TOKEN = process.env.FOODICS_API_TOKEN;
const POINTS_PER_SAR = parseFloat(process.env.LOYALTY_POINTS_PER_SAR || '1');
const POINTS_VALUE_SAR = parseFloat(process.env.LOYALTY_POINT_VALUE_SAR || '0.1');

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

async function foodicsRequest<T>(path: string, options?: RequestInit): Promise<T | null> {
  if (!FOODICS_TOKEN) return null;
  const url = `${FOODICS_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${FOODICS_TOKEN}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    console.warn('[Loyalty] Foodics request failed:', res.status);
    return null;
  }
  return (await res.json()) as T;
}

/** GET /api/loyalty/balance?customerId=X – get loyalty points balance */
loyaltyRouter.get('/balance', async (req, res) => {
  try {
    const customerId = req.query.customerId as string;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });

    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabaseAdmin
      .from('loyalty_points')
      .select('points, lifetime_points')
      .eq('customer_id', customerId)
      .single();

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ error: error.message });
    }

    const points = data?.points ?? 0;
    const lifetimePoints = data?.lifetime_points ?? 0;
    const pointsValue = +(points * POINTS_VALUE_SAR).toFixed(2);

    let foodicsLoyalty = null;
    if (FOODICS_TOKEN) {
      foodicsLoyalty = await foodicsRequest('/loyalty/balance', {
        method: 'POST',
        body: JSON.stringify({ customer_id: customerId }),
      });
    }

    res.json({
      points,
      lifetimePoints,
      pointsValue,
      pointsPerSar: POINTS_PER_SAR,
      pointValueSar: POINTS_VALUE_SAR,
      foodicsLoyalty,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get loyalty balance' });
  }
});

/** POST /api/loyalty/earn – award points for a completed order */
loyaltyRouter.post('/earn', async (req, res) => {
  try {
    const { customerId, orderId, orderSubtotal } = req.body;
    if (!customerId || !orderId || orderSubtotal == null) {
      return res.status(400).json({ error: 'customerId, orderId, and orderSubtotal required' });
    }
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const pointsEarned = Math.floor(Number(orderSubtotal) * POINTS_PER_SAR);

    const { data: existing } = await supabaseAdmin
      .from('loyalty_points')
      .select('points, lifetime_points')
      .eq('customer_id', customerId)
      .single();

    if (existing) {
      await supabaseAdmin
        .from('loyalty_points')
        .update({
          points: existing.points + pointsEarned,
          lifetime_points: existing.lifetime_points + pointsEarned,
          updated_at: new Date().toISOString(),
        })
        .eq('customer_id', customerId);
    } else {
      await supabaseAdmin.from('loyalty_points').insert({
        customer_id: customerId,
        points: pointsEarned,
        lifetime_points: pointsEarned,
      });
    }

    await supabaseAdmin.from('loyalty_transactions').insert({
      customer_id: customerId,
      order_id: orderId,
      type: 'earn',
      points: pointsEarned,
      description: `Earned from order ${orderId}`,
    });

    res.json({
      success: true,
      pointsEarned,
      newBalance: (existing?.points ?? 0) + pointsEarned,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to earn points' });
  }
});

/** POST /api/loyalty/redeem – redeem points at checkout */
loyaltyRouter.post('/redeem', async (req, res) => {
  try {
    const { customerId, points, orderId } = req.body;
    if (!customerId || !points || !orderId) {
      return res.status(400).json({ error: 'customerId, points, and orderId required' });
    }
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const pointsToRedeem = Math.floor(Number(points));
    if (pointsToRedeem <= 0) return res.status(400).json({ error: 'Invalid points amount' });

    const { data: balance } = await supabaseAdmin
      .from('loyalty_points')
      .select('points')
      .eq('customer_id', customerId)
      .single();

    if (!balance || balance.points < pointsToRedeem) {
      return res.status(400).json({ error: 'Insufficient points', available: balance?.points ?? 0 });
    }

    const discountSar = +(pointsToRedeem * POINTS_VALUE_SAR).toFixed(2);

    await supabaseAdmin
      .from('loyalty_points')
      .update({
        points: balance.points - pointsToRedeem,
        updated_at: new Date().toISOString(),
      })
      .eq('customer_id', customerId);

    await supabaseAdmin.from('loyalty_transactions').insert({
      customer_id: customerId,
      order_id: orderId,
      type: 'redeem',
      points: -pointsToRedeem,
      description: `Redeemed ${pointsToRedeem} points for ${discountSar} SAR discount`,
    });

    res.json({
      success: true,
      pointsRedeemed: pointsToRedeem,
      discountSar,
      newBalance: balance.points - pointsToRedeem,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to redeem points' });
  }
});

/** GET /api/loyalty/history?customerId=X – get loyalty transaction history */
loyaltyRouter.get('/history', async (req, res) => {
  try {
    const customerId = req.query.customerId as string;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data, error } = await supabaseAdmin
      .from('loyalty_transactions')
      .select('*')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ transactions: data ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to get history' });
  }
});
