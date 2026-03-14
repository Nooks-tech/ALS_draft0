/**
 * Google Wallet – Generic/Loyalty pass generation.
 * Creates a signed JWT that produces an "Add to Google Wallet" URL.
 *
 * Required env vars:
 *   GOOGLE_WALLET_ISSUER_ID        – your issuer ID from Google Pay Business Console
 *   GOOGLE_WALLET_SERVICE_ACCOUNT_JSON – the full JSON key of a GCP service account
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import jwt from 'jsonwebtoken';

export const googleWalletRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const ISSUER_ID = process.env.GOOGLE_WALLET_ISSUER_ID;

let serviceAccount: { client_email: string; private_key: string } | null = null;
try {
  const raw = process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON;
  if (raw) serviceAccount = JSON.parse(raw);
} catch {
  console.warn('[GoogleWallet] Failed to parse GOOGLE_WALLET_SERVICE_ACCOUNT_JSON');
}

function isConfigured(): boolean {
  return !!(ISSUER_ID && serviceAccount?.client_email && serviceAccount?.private_key);
}

/**
 * GET /api/loyalty/google-wallet/check
 */
googleWalletRouter.get('/google-wallet/check', (_req, res) => {
  res.json({ available: isConfigured() });
});

/**
 * GET /api/loyalty/google-wallet?customerId=X&merchantId=X
 * Returns a JSON with `saveUrl` – the "Add to Google Wallet" link.
 */
googleWalletRouter.get('/google-wallet', async (req, res) => {
  try {
    const customerId = req.query.customerId as string;
    const merchantId = req.query.merchantId as string;
    if (!customerId || !merchantId) {
      return res.status(400).json({ error: 'customerId and merchantId required' });
    }

    if (!isConfigured() || !serviceAccount) {
      return res.status(501).json({
        error: 'Google Wallet not configured. Required env vars: GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SERVICE_ACCOUNT_JSON',
      });
    }

    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: pointsData } = await supabaseAdmin
      .from('loyalty_points')
      .select('points, lifetime_points')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .single();

    const points = pointsData?.points ?? 0;
    const lifetimePoints = pointsData?.lifetime_points ?? 0;
    const tierName = lifetimePoints >= 5000 ? 'Gold' : lifetimePoints >= 1000 ? 'Silver' : 'Bronze';

    const { data: config } = await supabaseAdmin
      .from('loyalty_config')
      .select('*')
      .eq('merchant_id', merchantId)
      .single();

    const { data: merchant } = await supabaseAdmin
      .from('merchants')
      .select('cafe_name')
      .eq('id', merchantId)
      .single();

    const bgColor = config?.wallet_card_bg_color || '#0D9488';
    const cardLabel = config?.wallet_card_label || merchant?.cafe_name || 'Loyalty Card';
    const pointValueSar = config?.point_value_sar ?? 0.1;

    const classId = `${ISSUER_ID}.nooks_loyalty_${merchantId.replace(/-/g, '_')}`;
    const objectId = `${ISSUER_ID}.loyalty_${merchantId.replace(/-/g, '_')}_${customerId.replace(/-/g, '_')}`;

    const loyaltyClass = {
      id: classId,
      issuerName: cardLabel,
      programName: `${cardLabel} Rewards`,
      programLogo: config?.wallet_card_logo_url
        ? { sourceUri: { uri: config.wallet_card_logo_url }, contentDescription: { defaultValue: { language: 'en', value: cardLabel } } }
        : undefined,
      hexBackgroundColor: bgColor,
      reviewStatus: 'UNDER_REVIEW',
    };

    const loyaltyObject = {
      id: objectId,
      classId,
      state: 'ACTIVE',
      loyaltyPoints: {
        label: 'Points',
        balance: { int: points },
      },
      accountId: customerId,
      accountName: tierName + ' Member',
      textModulesData: [
        { header: 'Points Value', body: `${(points * pointValueSar).toFixed(2)} SAR` },
        { header: 'Tier', body: tierName },
        { header: 'Lifetime Points', body: String(lifetimePoints) },
      ],
      barcode: {
        type: 'QR_CODE',
        value: customerId,
      },
    };

    const token = jwt.sign(
      {
        iss: serviceAccount.client_email,
        aud: 'google',
        typ: 'savetowallet',
        origins: [],
        payload: {
          loyaltyClasses: [loyaltyClass],
          loyaltyObjects: [loyaltyObject],
        },
      },
      serviceAccount.private_key,
      { algorithm: 'RS256' },
    );

    const saveUrl = `https://pay.google.com/gp/v/save/${token}`;

    res.json({ saveUrl });
  } catch (err: any) {
    console.error('[GoogleWallet] Error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to generate Google Wallet pass' });
  }
});
