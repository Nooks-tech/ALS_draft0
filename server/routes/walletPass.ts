/**
 * Apple Wallet Pass generation using passkit-generator with runtime key-parsing fix.
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import forge from 'node-forge';

// Runtime fix: passkit-generator uses forge.pki.decryptRsaPrivateKey which
// returns null for unencrypted PKCS#8 keys. Patch it BEFORE importing PKPass.
const _origDecrypt = forge.pki.decryptRsaPrivateKey;
forge.pki.decryptRsaPrivateKey = function (pem: string, passphrase: string) {
  const result = _origDecrypt(pem, passphrase);
  if (result) return result;
  try { return forge.pki.privateKeyFromPem(pem) as any; } catch { return null; }
};

import { PKPass } from 'passkit-generator';

export const walletPassRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const PASS_TYPE_ID = process.env.APPLE_PASS_TYPE_ID || '';
const TEAM_ID = process.env.APPLE_PASS_TEAM_ID || '';
const CERT_BASE64 = process.env.APPLE_PASS_CERT_BASE64 || '';
const KEY_BASE64 = process.env.APPLE_PASS_KEY_BASE64 || '';
const KEY_PASSPHRASE = process.env.APPLE_PASS_KEY_PASSPHRASE || 'not-encrypted';
const WWDR_BASE64 = process.env.APPLE_WWDR_CERT_BASE64 || '';

function isConfigured() {
  return !!(PASS_TYPE_ID && TEAM_ID && CERT_BASE64 && KEY_BASE64 && WWDR_BASE64);
}

function decode(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

function hexToRgb(hex: string): string {
  if (!hex || typeof hex !== 'string') return 'rgb(0, 0, 0)';
  if (hex.startsWith('rgb')) return hex;
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return 'rgb(0, 0, 0)';
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

const ICON_1X = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAB0AAAAdCAIAAADZ8fBYAAAAJUlEQVR4nGNgmNJBEzRq7qi5o+aOmjtq7qi5o+aOmjtq7qAyFwCzp6UqMm3T+QAAAABJRU5ErkJggg==', 'base64');
const ICON_2X = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADoAAAA6CAIAAABu2d1/AAAAZUlEQVR4nO3OAQkAMAzAsMm/gAm+jHZQiIDM7LuEH9TV4Ad1NfhBXQ1+UFeDH9TV4Ad1NfhBXQ1+UFeDH9TV4Ad1NfhBXQ1+UFeDH9TV4Ad1NfhBXQ1+UFeDH9TV4Ad1NfhBXYsP2s6Uw9dI6msAAAAASUVORK5CYII=', 'base64');
const ICON_3X = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAFcAAABXCAIAAAD+qk47AAAA9ElEQVR4nO3OQQ0AIAADsclHAIKR0XuQVEC3e775QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfBDx2KM69DQL8FwAAAABJRU5ErkJggg==', 'base64');

function getCerts() {
  return {
    signerCert: decode(CERT_BASE64),
    signerKey: decode(KEY_BASE64),
    signerKeyPassphrase: KEY_PASSPHRASE,
    wwdr: decode(WWDR_BASE64),
  };
}

async function createPass(opts: {
  serialNumber: string;
  description: string;
  organizationName: string;
  bgColor: string;
  fgColor: string;
  labelColor: string;
  cardLabel: string;
  points: number;
  lifetimePoints: number;
  pointValueSar: number;
  stamps?: { current: number; target: number } | null;
  customerId: string;
  logoBuffer?: Buffer | null;
}): Promise<Buffer> {
  const buffers: Record<string, Buffer> = {
    'icon.png': ICON_1X,
    'icon@2x.png': ICON_2X,
    'icon@3x.png': ICON_3X,
  };
  if (opts.logoBuffer) {
    buffers['logo.png'] = opts.logoBuffer;
    buffers['logo@2x.png'] = opts.logoBuffer;
  }

  const pass = new PKPass(buffers, getCerts(), {
    formatVersion: 1,
    passTypeIdentifier: PASS_TYPE_ID,
    teamIdentifier: TEAM_ID,
    serialNumber: opts.serialNumber,
    description: opts.description,
    organizationName: opts.organizationName,
    backgroundColor: opts.bgColor,
    foregroundColor: opts.fgColor,
    labelColor: opts.labelColor,
  });

  pass.type = 'generic';
  pass.headerFields.push({ key: 'points', label: 'POINTS', value: String(opts.points) });
  pass.primaryFields.push({ key: 'balance', label: opts.cardLabel, value: `${opts.points} points` });
  pass.secondaryFields.push({ key: 'value', label: 'VALUE', value: `${(opts.points * opts.pointValueSar).toFixed(2)} SAR` });
  if (opts.stamps) {
    pass.secondaryFields.push({ key: 'stamps', label: 'STAMPS', value: `${opts.stamps.current} / ${opts.stamps.target}` });
  }
  pass.backFields.push({ key: 'lifetime', label: 'Lifetime Points', value: String(opts.lifetimePoints) });
  pass.setBarcodes({ format: 'PKBarcodeFormatQR', message: opts.customerId, messageEncoding: 'iso-8859-1' });

  return pass.getAsBuffer();
}

// ─── Routes ───

walletPassRouter.get('/wallet-pass/check', (_req, res) => {
  if (!isConfigured() || !supabaseAdmin) return res.status(501).json({ available: false });
  res.json({ available: true });
});

walletPassRouter.get('/wallet-pass/debug', async (_req, res) => {
  const info: Record<string, unknown> = {
    passTypeId: PASS_TYPE_ID,
    teamId: TEAM_ID,
    configured: isConfigured(),
    version: 'v15-passkit-gen-runtime-patch',
  };

  try {
    const testBuf = await createPass({
      serialNumber: 'debug-test',
      description: 'Debug',
      organizationName: 'Debug',
      bgColor: 'rgb(0,0,0)',
      fgColor: 'rgb(255,255,255)',
      labelColor: 'rgb(255,255,255)',
      cardLabel: 'Debug',
      points: 0,
      lifetimePoints: 0,
      pointValueSar: 0.1,
      customerId: 'debug',
    });
    info.testPassSize = testBuf.length;
    info.testPassFirstBytes = '0x' + testBuf.subarray(0, 4).toString('hex');

    // Quick inspect: unzip and check manifest + signature
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(testBuf);
    const manifestEntry = zip.getEntry('manifest.json');
    const sigEntry = zip.getEntry('signature');
    const passEntry = zip.getEntry('pass.json');
    if (manifestEntry) {
      const mj = JSON.parse(manifestEntry.getData().toString('utf-8'));
      info.manifestKeys = Object.keys(mj);
      const firstHash = Object.values(mj)[0] as string;
      info.hashLength = firstHash?.length; // 40=SHA1, 64=SHA256
    }
    if (sigEntry) {
      info.signatureSize = sigEntry.getData().length;
      const sigDer = sigEntry.getData();
      const asn1 = forge.asn1.fromDer(new forge.util.ByteStringBuffer(sigDer.toString('binary')));
      const p7 = (forge.pkcs7 as any).messageFromAsn1(asn1);
      info.certCount = p7.certificates?.length;
      const rc = p7.rawCapture || {};
      info.signerCount = rc.signerInfos?.length ?? 0;
    }
    if (passEntry) {
      const pj = JSON.parse(passEntry.getData().toString('utf-8'));
      info.passTypeInJson = pj.passTypeIdentifier;
      info.teamInJson = pj.teamIdentifier;
    }
  } catch (e: any) {
    info.error = e.message;
    info.stack = e.stack?.substring(0, 300);
  }

  res.json(info);
});

walletPassRouter.get('/wallet-pass/test', async (_req, res) => {
  try {
    if (!isConfigured()) return res.status(501).json({ error: 'Not configured' });

    const pkpass = await createPass({
      serialNumber: `test-${Date.now()}`,
      description: 'Test loyalty card',
      organizationName: 'Test',
      bgColor: 'rgb(0, 148, 136)',
      fgColor: 'rgb(255, 255, 255)',
      labelColor: 'rgb(255, 255, 255)',
      cardLabel: 'Loyalty Card',
      points: 0,
      lifetimePoints: 0,
      pointValueSar: 0.1,
      customerId: 'test-customer',
    });

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'inline; filename="test.pkpass"',
      'Content-Length': String(pkpass.length),
    });
    res.send(pkpass);
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
      .eq('merchant_id', merchantId).maybeSingle();

    const bgColor = config?.wallet_card_bg_color || '#0D9488';
    const textColor = config?.wallet_card_text_color || '#FFFFFF';
    const cardLabel = config?.wallet_card_label || 'Loyalty Card';
    const pointsPerSar = config?.points_per_sar ?? 0.1;
    const pointValueSar = pointsPerSar > 0 ? 1 : 0.1;

    let logoBuffer: Buffer | null = null;
    if (config?.wallet_card_logo_url) {
      try {
        const logoRes = await fetch(config.wallet_card_logo_url);
        if (logoRes.ok) logoBuffer = Buffer.from(await logoRes.arrayBuffer());
      } catch { /* skip */ }
    }

    const pkpass = await createPass({
      serialNumber: `loyalty-${merchantId}-${customerId}`,
      description: cardLabel,
      organizationName: cardLabel,
      bgColor: hexToRgb(bgColor),
      fgColor: hexToRgb(textColor),
      labelColor: hexToRgb(textColor),
      cardLabel,
      points,
      lifetimePoints,
      pointValueSar,
      stamps: (config?.stamp_enabled && stampData) ? { current: stampData.stamps ?? 0, target: config.stamp_target } : null,
      customerId,
      logoBuffer,
    });

    if (req.query.format === 'base64') {
      return res.json({ base64: pkpass.toString('base64'), size: pkpass.length });
    }

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'inline; filename="loyalty-card.pkpass"',
      'Content-Length': String(pkpass.length),
    });
    res.send(pkpass);
  } catch (err: any) {
    console.error('[WalletPass]', err?.message, err?.stack?.substring(0, 300));
    res.status(500).json({ error: err?.message || 'Failed to generate wallet pass' });
  }
});
