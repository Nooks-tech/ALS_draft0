/**
 * Apple Wallet Pass generation using passkit-generator (80K+ weekly downloads).
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';

const { PKPass } = require('passkit-generator');

export const walletPassRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const PASS_TYPE_ID = process.env.APPLE_PASS_TYPE_ID;
const TEAM_ID = process.env.APPLE_PASS_TEAM_ID;
const CERT_BASE64 = process.env.APPLE_PASS_CERT_BASE64;
const KEY_BASE64 = process.env.APPLE_PASS_KEY_BASE64;
const KEY_PASSPHRASE = process.env.APPLE_PASS_KEY_PASSPHRASE || '';
const WWDR_BASE64 = process.env.APPLE_WWDR_CERT_BASE64;

function isConfigured() {
  return !!(PKPass && PASS_TYPE_ID && TEAM_ID && CERT_BASE64 && KEY_BASE64 && WWDR_BASE64);
}

function decode(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return hex;
  return `rgb(${r}, ${g}, ${b})`;
}

const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAABl0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMC4xNkRECVkAAAANSURBVBhXY/j//z8DAAj8Av6IXwboAAAAAElFTkSuQmCC',
  'base64'
);

function getCertificates() {
  return {
    wwdr: decode(WWDR_BASE64!),
    signerCert: decode(CERT_BASE64!),
    signerKey: decode(KEY_BASE64!),
    signerKeyPassphrase: KEY_PASSPHRASE || undefined,
  };
}

// ─── Routes ───

walletPassRouter.get('/wallet-pass/check', (_req, res) => {
  if (!isConfigured() || !supabaseAdmin) return res.status(501).json({ available: false });
  res.json({ available: true });
});

walletPassRouter.get('/wallet-pass/debug', (_req, res) => {
  const info: Record<string, unknown> = {
    passTypeId: PASS_TYPE_ID || '(not set)',
    teamId: TEAM_ID || '(not set)',
    certLength: CERT_BASE64 ? CERT_BASE64.length : 0,
    keyLength: KEY_BASE64 ? KEY_BASE64.length : 0,
    wwdrLength: WWDR_BASE64 ? WWDR_BASE64.length : 0,
    keyPassphraseSet: !!KEY_PASSPHRASE,
    configured: isConfigured(),
    version: 'v4-passkit-generator',
    library: 'passkit-generator',
  };
  res.json(info);
});

walletPassRouter.get('/wallet-pass/test', async (_req, res) => {
  try {
    if (!isConfigured()) return res.status(501).json({ error: 'Not configured' });

    const pass = new PKPass(
      { 'icon.png': MINIMAL_PNG, 'icon@2x.png': MINIMAL_PNG },
      getCertificates(),
      {
        passTypeIdentifier: PASS_TYPE_ID,
        teamIdentifier: TEAM_ID,
        serialNumber: `test-${Date.now()}`,
        description: 'Test loyalty card',
        organizationName: 'Test',
        backgroundColor: 'rgb(0, 148, 136)',
        foregroundColor: 'rgb(255, 255, 255)',
        labelColor: 'rgb(255, 255, 255)',
      }
    );

    pass.type = 'generic';
    pass.headerFields.push({ key: 'points', label: 'POINTS', value: '0' });
    pass.primaryFields.push({ key: 'balance', label: 'Loyalty Card', value: '0 points' });
    pass.secondaryFields.push({ key: 'value', label: 'VALUE', value: '0.00 SAR' });
    pass.backFields.push({ key: 'lifetime', label: 'Lifetime Points', value: '0' });
    pass.setBarcodes({ format: 'PKBarcodeFormatQR', message: 'test-customer', messageEncoding: 'iso-8859-1' });

    const buffer = pass.getAsBuffer();

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'inline; filename="test.pkpass"',
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  } catch (err: any) {
    console.error('[WalletPass/test]', err);
    res.status(500).json({ error: err.message, stack: err.stack?.substring(0, 500) });
  }
});

walletPassRouter.get('/wallet-pass', async (req, res) => {
  try {
    const customerId = req.query.customerId as string;
    const merchantId = req.query.merchantId as string;
    if (!customerId || !merchantId) return res.status(400).json({ error: 'customerId and merchantId required' });
    if (!isConfigured()) return res.status(501).json({ error: 'Apple Wallet pass not configured' });
    if (!supabaseAdmin) return res.status(500).json({ error: 'Database not configured' });

    const { data: pointsData } = await supabaseAdmin
      .from('loyalty_points').select('points, lifetime_points')
      .eq('customer_id', customerId).eq('merchant_id', merchantId).single();
    const points = pointsData?.points ?? 0;
    const lifetimePoints = pointsData?.lifetime_points ?? 0;

    const { data: stampData } = await supabaseAdmin
      .from('loyalty_stamps').select('stamps, completed_cards')
      .eq('customer_id', customerId).eq('merchant_id', merchantId).single();

    const { data: config } = await supabaseAdmin
      .from('loyalty_config').select('*')
      .eq('merchant_id', merchantId).single();

    const bgColor = config?.wallet_card_bg_color || '#0D9488';
    const textColor = config?.wallet_card_text_color || '#FFFFFF';
    const cardLabel = config?.wallet_card_label || 'Loyalty Card';
    const pointsPerSar = config?.points_per_sar ?? 0.1;
    const pointValueSar = pointsPerSar > 0 ? 1 : 0.1;

    const buffers: Record<string, Buffer> = { 'icon.png': MINIMAL_PNG, 'icon@2x.png': MINIMAL_PNG };

    if (config?.wallet_card_logo_url) {
      try {
        const logoRes = await fetch(config.wallet_card_logo_url);
        if (logoRes.ok) {
          const logoBuf = Buffer.from(await logoRes.arrayBuffer());
          buffers['logo.png'] = logoBuf;
          buffers['logo@2x.png'] = logoBuf;
        }
      } catch { /* skip */ }
    }

    const pass = new PKPass(buffers, getCertificates(), {
      passTypeIdentifier: PASS_TYPE_ID,
      teamIdentifier: TEAM_ID,
      serialNumber: `loyalty-${merchantId}-${customerId}`,
      description: cardLabel,
      organizationName: cardLabel,
      backgroundColor: hexToRgb(bgColor),
      foregroundColor: hexToRgb(textColor),
      labelColor: hexToRgb(textColor),
    });

    pass.type = 'generic';
    pass.headerFields.push({ key: 'points', label: 'POINTS', value: String(points) });
    pass.primaryFields.push({ key: 'balance', label: cardLabel, value: `${points} points` });
    pass.secondaryFields.push({ key: 'value', label: 'VALUE', value: `${(points * pointValueSar).toFixed(2)} SAR` });

    if (config?.stamp_enabled && stampData) {
      pass.secondaryFields.push({ key: 'stamps', label: 'STAMPS', value: `${stampData.stamps ?? 0} / ${config.stamp_target}` });
    }

    pass.backFields.push({ key: 'lifetime', label: 'Lifetime Points', value: String(lifetimePoints) });
    pass.setBarcodes({ format: 'PKBarcodeFormatQR', message: customerId, messageEncoding: 'iso-8859-1' });

    const buffer = pass.getAsBuffer();

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'inline; filename="loyalty-card.pkpass"',
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  } catch (err: any) {
    console.error('[WalletPass]', err?.message, err?.stack?.substring(0, 300));
    res.status(500).json({ error: err?.message || 'Failed to generate wallet pass' });
  }
});
