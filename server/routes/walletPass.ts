/**
 * Apple Wallet Pass generation — fully manual implementation.
 * Uses node-forge for PKCS#7 signing and do-not-zip for archive creation.
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import * as forge from 'node-forge';

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

// ─── Crypto helpers (mirrors passkit-generator's Signature.ts exactly) ───

function sha256Hex(buf: Buffer): string {
  const h = forge.md.sha256.create();
  h.update(buf.toString('binary'));
  return h.digest().toHex();
}

function parsePrivateKey(): forge.pki.rsa.PrivateKey {
  const pem = decode(KEY_BASE64!).toString('utf-8');

  // Try with passphrase first (encrypted key)
  if (KEY_PASSPHRASE) {
    const k = forge.pki.decryptRsaPrivateKey(pem, KEY_PASSPHRASE);
    if (k) return k;
  }
  // Try as unencrypted PEM (PKCS#1 or PKCS#8)
  try { return forge.pki.privateKeyFromPem(pem) as forge.pki.rsa.PrivateKey; } catch {}
  // Try decrypt with empty passphrase
  const k2 = forge.pki.decryptRsaPrivateKey(pem, '');
  if (k2) return k2;

  throw new Error('Cannot parse signer private key');
}

function signManifest(manifestBuffer: Buffer): Buffer {
  const signerCert = forge.pki.certificateFromPem(decode(CERT_BASE64!).toString('utf-8'));
  const wwdrCert = forge.pki.certificateFromPem(decode(WWDR_BASE64!).toString('utf-8'));
  const signerKey = parsePrivateKey();

  const p7 = forge.pkcs7.createSignedData();
  p7.content = new forge.util.ByteStringBuffer(manifestBuffer.toString('binary'));

  p7.addCertificate(wwdrCert);
  p7.addCertificate(signerCert);

  p7.addSigner({
    key: signerKey,
    certificate: signerCert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime },
    ],
  });

  p7.sign({ detached: true });

  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

function buildPkpass(files: Record<string, Buffer>): Buffer {
  const manifest: Record<string, string> = {};
  for (const [name, buf] of Object.entries(files)) {
    manifest[name] = sha256Hex(buf);
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  const signatureBuf = signManifest(manifestBuf);

  const allFiles: Record<string, Buffer> = {
    ...files,
    'manifest.json': manifestBuf,
    'signature': signatureBuf,
  };

  const { toBuffer } = require('do-not-zip');
  return toBuffer(
    Object.entries(allFiles).map(([path, data]) => ({ path, data })),
  );
}

function buildPassJson(opts: {
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
}): Buffer {
  return Buffer.from(JSON.stringify({
    formatVersion: 1,
    passTypeIdentifier: PASS_TYPE_ID,
    teamIdentifier: TEAM_ID,
    serialNumber: opts.serialNumber,
    description: opts.description,
    organizationName: opts.organizationName,
    backgroundColor: opts.bgColor,
    foregroundColor: opts.fgColor,
    labelColor: opts.labelColor,
    generic: {
      headerFields: [
        { key: 'points', label: 'POINTS', value: String(opts.points) },
      ],
      primaryFields: [
        { key: 'balance', label: opts.cardLabel, value: `${opts.points} points` },
      ],
      secondaryFields: [
        { key: 'value', label: 'VALUE', value: `${(opts.points * opts.pointValueSar).toFixed(2)} SAR` },
        ...(opts.stamps ? [{ key: 'stamps', label: 'STAMPS', value: `${opts.stamps.current} / ${opts.stamps.target}` }] : []),
      ],
      auxiliaryFields: [],
      backFields: [
        { key: 'lifetime', label: 'Lifetime Points', value: String(opts.lifetimePoints) },
      ],
    },
    barcodes: [
      { format: 'PKBarcodeFormatQR', message: opts.customerId, messageEncoding: 'iso-8859-1' },
    ],
  }));
}

// ─── Routes ───

walletPassRouter.get('/wallet-pass/check', (_req, res) => {
  if (!isConfigured() || !supabaseAdmin) return res.status(501).json({ available: false });
  res.json({ available: true });
});

walletPassRouter.get('/wallet-pass/debug', (_req, res) => {
  const info: Record<string, unknown> = {
    passTypeId: PASS_TYPE_ID,
    teamId: TEAM_ID,
    configured: isConfigured(),
    version: 'v14-sha256-for-wwdr-g4',
  };

  try {
    const key = parsePrivateKey();
    info.keyParsed = key ? 'OK (type: ' + typeof key + ')' : 'NULL!';

    const cert = forge.pki.certificateFromPem(decode(CERT_BASE64!).toString('utf-8'));
    info.certCN = cert.subject.getField('CN')?.value;

    // Generate a test pass and inspect its signature
    const testManifest = Buffer.from('{"test":"ok"}');
    const testSig = signManifest(testManifest);
    info.testSigSize = testSig.length;

    // Parse the signature back to verify it has a signer
    const asn1 = forge.asn1.fromDer(new forge.util.ByteStringBuffer(testSig.toString('binary')));
    const p7 = forge.pkcs7.messageFromAsn1(asn1);
    const rc = (p7 as any).rawCapture || {};
    info.signerInfosInSignature = rc.signerInfos?.length ?? 'none';
  } catch (e: any) {
    info.error = e.message;
  }

  res.json(info);
});

walletPassRouter.get('/wallet-pass/test', async (_req, res) => {
  try {
    if (!isConfigured()) return res.status(501).json({ error: 'Not configured' });

    const files: Record<string, Buffer> = {
      'icon.png': ICON_1X,
      'icon@2x.png': ICON_2X,
      'icon@3x.png': ICON_3X,
      'pass.json': buildPassJson({
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
      }),
    };

    const pkpass = buildPkpass(files);

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

    const files: Record<string, Buffer> = {
      'icon.png': ICON_1X,
      'icon@2x.png': ICON_2X,
      'icon@3x.png': ICON_3X,
    };

    if (config?.wallet_card_logo_url) {
      try {
        const logoRes = await fetch(config.wallet_card_logo_url);
        if (logoRes.ok) {
          const logoBuf = Buffer.from(await logoRes.arrayBuffer());
          files['logo.png'] = logoBuf;
          files['logo@2x.png'] = logoBuf;
        }
      } catch { /* skip */ }
    }

    files['pass.json'] = buildPassJson({
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
    });

    const pkpass = buildPkpass(files);

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
