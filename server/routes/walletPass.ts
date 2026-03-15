/**
 * Apple Wallet Pass generation for loyalty cards.
 * Requires: APPLE_PASS_TYPE_ID, APPLE_PASS_TEAM_ID, APPLE_PASS_CERT_BASE64, APPLE_PASS_KEY_BASE64
 * Optional: APPLE_PASS_KEY_PASSPHRASE
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';

let PKPass: any;
try {
  PKPass = require('passkit-generator').PKPass;
} catch {
  console.warn('[WalletPass] passkit-generator not available');
}

export const walletPassRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const PASS_TYPE_ID = process.env.APPLE_PASS_TYPE_ID;
const TEAM_ID = process.env.APPLE_PASS_TEAM_ID;
const CERT_BASE64 = process.env.APPLE_PASS_CERT_BASE64;
const KEY_BASE64 = process.env.APPLE_PASS_KEY_BASE64;
const KEY_PASSPHRASE = process.env.APPLE_PASS_KEY_PASSPHRASE;
const WWDR_BASE64 = process.env.APPLE_WWDR_CERT_BASE64;

/**
 * GET /api/loyalty/wallet-pass/check
 * Returns 200 if Apple Wallet pass generation is configured, 501 otherwise.
 */
walletPassRouter.get('/wallet-pass/check', (_req, res) => {
  if (!PKPass || !PASS_TYPE_ID || !TEAM_ID || !CERT_BASE64 || !KEY_BASE64) {
    return res.status(501).json({ available: false });
  }
  res.json({ available: true });
});

walletPassRouter.get('/wallet-pass/debug', (_req, res) => {
  res.json({
    passTypeId: PASS_TYPE_ID || '(not set)',
    teamId: TEAM_ID || '(not set)',
    certLength: CERT_BASE64 ? CERT_BASE64.length : 0,
    keyLength: KEY_BASE64 ? KEY_BASE64.length : 0,
    wwdrLength: WWDR_BASE64 ? WWDR_BASE64.length : 0,
    keyPassphraseSet: !!KEY_PASSPHRASE,
    pkPassAvailable: !!PKPass,
  });
});

/**
 * GET /api/loyalty/wallet-pass?customerId=X&merchantId=X
 * Returns a .pkpass file for the customer's loyalty card.
 */
walletPassRouter.get('/wallet-pass', async (req, res) => {
  try {
    const customerId = req.query.customerId as string;
    const merchantId = req.query.merchantId as string;
    if (!customerId || !merchantId) {
      return res.status(400).json({ error: 'customerId and merchantId required' });
    }

    if (!PKPass || !PASS_TYPE_ID || !TEAM_ID || !CERT_BASE64 || !KEY_BASE64) {
      return res.status(501).json({
        error: 'Apple Wallet pass not configured. Required env vars: APPLE_PASS_TYPE_ID, APPLE_PASS_TEAM_ID, APPLE_PASS_CERT_BASE64, APPLE_PASS_KEY_BASE64',
      });
    }

    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    // Fetch loyalty balance
    const { data: pointsData } = await supabaseAdmin
      .from('loyalty_points')
      .select('points, lifetime_points')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .single();

    const points = pointsData?.points ?? 0;
    const lifetimePoints = pointsData?.lifetime_points ?? 0;
    const tierName = lifetimePoints >= 5000 ? 'Gold' : lifetimePoints >= 1000 ? 'Silver' : 'Bronze';

    // Fetch stamp progress
    const { data: stampData } = await supabaseAdmin
      .from('loyalty_stamps')
      .select('stamps, completed_cards')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .single();

    // Fetch merchant config for wallet card design
    const { data: config } = await supabaseAdmin
      .from('loyalty_config')
      .select('*')
      .eq('merchant_id', merchantId)
      .single();

    const bgColor = config?.wallet_card_bg_color || '#0D9488';
    const textColor = config?.wallet_card_text_color || '#FFFFFF';
    const cardLabel = config?.wallet_card_label || 'Loyalty Card';
    const secondaryLabel = config?.wallet_card_secondary_label || '';
    const pointsPerSar = config?.points_per_sar ?? 0.1;
    const pointValueSar = pointsPerSar > 0 ? 1 : 0.1;

    // Decode certificates
    const signerCert = Buffer.from(CERT_BASE64, 'base64');
    const signerKey = Buffer.from(KEY_BASE64, 'base64');
    const wwdr = WWDR_BASE64 ? Buffer.from(WWDR_BASE64, 'base64') : undefined;

    const certConfig: Record<string, unknown> = { signerCert, signerKey };
    if (KEY_PASSPHRASE) certConfig.signerKeyPassphrase = KEY_PASSPHRASE;
    if (wwdr) certConfig.wwdr = wwdr;

    // Create a 1x1 transparent PNG as minimal icon
    const MINIMAL_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAABl0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMC4xNkRECVkAAAANSURBVBhXY/j//z8DAAj8Av6IXwboAAAAAElFTkSuQmCC',
      'base64'
    );

    const buffers: Record<string, Buffer> = {
      'icon.png': MINIMAL_PNG,
      'icon@2x.png': MINIMAL_PNG,
    };

    // Download merchant logo if available
    if (config?.wallet_card_logo_url) {
      try {
        const logoRes = await fetch(config.wallet_card_logo_url);
        if (logoRes.ok) {
          const logoBuffer = Buffer.from(await logoRes.arrayBuffer());
          buffers['logo.png'] = logoBuffer;
          buffers['logo@2x.png'] = logoBuffer;
        }
      } catch { /* use default */ }
    }

    const pass = new PKPass(buffers, certConfig, {
      formatVersion: 1,
      passTypeIdentifier: PASS_TYPE_ID,
      teamIdentifier: TEAM_ID,
      organizationName: cardLabel,
      serialNumber: `loyalty-${merchantId}-${customerId}`,
      description: cardLabel,
      backgroundColor: bgColor,
      foregroundColor: textColor,
      labelColor: textColor,
    });

    pass.type = 'generic';

    pass.headerFields.push({ key: 'points', label: 'POINTS', value: String(points) });
    pass.primaryFields.push({ key: 'balance', label: cardLabel, value: `${points} points` });
    pass.secondaryFields.push({ key: 'tier', label: 'TIER', value: tierName });
    if (config?.stamp_enabled && stampData) {
      pass.secondaryFields.push({ key: 'stamps', label: 'STAMPS', value: `${stampData.stamps ?? 0} / ${config.stamp_target}` });
    }
    pass.secondaryFields.push({ key: 'value', label: 'VALUE', value: `${(points * pointValueSar).toFixed(2)} SAR` });
    if (secondaryLabel) {
      pass.auxiliaryFields.push({ key: 'subtitle', label: 'MEMBER', value: secondaryLabel });
    }
    pass.backFields.push(
      { key: 'lifetime', label: 'Lifetime Points', value: String(lifetimePoints) },
      { key: 'completed', label: 'Completed Stamp Cards', value: String(stampData?.completed_cards ?? 0) },
    );

    pass.setBarcodes({ format: 'PKBarcodeFormatQR', message: customerId, messageEncoding: 'iso-8859-1' });

    const buffer = pass.getAsBuffer();

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': `inline; filename="loyalty-card.pkpass"`,
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  } catch (err: any) {
    console.error('[WalletPass] Error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to generate wallet pass' });
  }
});
