/**
 * Apple Wallet Pass generation for loyalty cards.
 * Uses node-forge for PKCS#7 detached signature with SHA-1 digest
 * (Apple's required format for .pkpass files).
 */
import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';

let forge: any;
try { forge = require('node-forge'); } catch {}

let doNotZip: any;
try { doNotZip = require('do-not-zip'); } catch {}

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

function isConfigured() {
  return !!(forge && doNotZip && PASS_TYPE_ID && TEAM_ID && CERT_BASE64 && KEY_BASE64 && WWDR_BASE64);
}

function ensurePem(buf: Buffer, type: string): Buffer {
  const str = buf.toString('utf-8');
  if (str.includes('-----BEGIN')) return buf;
  const b64 = buf.toString('base64');
  const lines = b64.match(/.{1,64}/g)!.join('\n');
  return Buffer.from(`-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`);
}

function signManifest(manifestJson: string, certPem: string, keyPem: string, wwdrPem: string): Buffer {
  const cert = forge.pki.certificateFromPem(certPem);
  const wwdrCert = forge.pki.certificateFromPem(wwdrPem);

  let key: any;
  if (KEY_PASSPHRASE) {
    key = forge.pki.decryptRsaPrivateKey(keyPem, KEY_PASSPHRASE);
  } else {
    key = forge.pki.privateKeyFromPem(keyPem);
  }

  if (!key) {
    throw new Error('Failed to parse private key — check KEY_BASE64 and KEY_PASSPHRASE');
  }

  const p7 = forge.pkcs7.createSignedData();
  p7.content = manifestJson;
  p7.addCertificate(wwdrCert);
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha1,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime },
    ],
  });
  p7.sign({ detached: true });

  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return hex;
  return `rgb(${r}, ${g}, ${b})`;
}

function buildPkpass(
  passJson: Record<string, unknown>,
  assets: Record<string, Buffer>,
  certPem: string,
  keyPem: string,
  wwdrPem: string,
): Buffer {
  const files: Record<string, Buffer> = { ...assets };
  files['pass.json'] = Buffer.from(JSON.stringify(passJson));

  const manifest: Record<string, string> = {};
  for (const [name, buf] of Object.entries(files)) {
    manifest[name] = createHash('sha1').update(buf).digest('hex');
  }
  const manifestJson = JSON.stringify(manifest);
  const manifestBuf = Buffer.from(manifestJson);
  const signatureBuf = signManifest(manifestJson, certPem, keyPem, wwdrPem);

  const zipEntries = [
    ...Object.entries(files).map(([p, data]) => ({ path: p, data })),
    { path: 'manifest.json', data: manifestBuf },
    { path: 'signature', data: signatureBuf },
  ];

  return Buffer.from(doNotZip.toArray(zipEntries));
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
    forgeAvailable: !!forge,
    doNotZipAvailable: !!doNotZip,
    pkPassAvailable: isConfigured(),
    manifestHash: 'SHA-1',
    signatureDigest: 'SHA-1',
    signatureMethod: 'node-forge PKCS#7 detached',
  };

  try {
    if (CERT_BASE64) {
      const certBuf = ensurePem(Buffer.from(CERT_BASE64, 'base64'), 'CERTIFICATE');
      const certStr = certBuf.toString('utf-8');
      info.certIsPem = certStr.includes('-----BEGIN');
      try {
        const cert = forge.pki.certificateFromPem(certStr);
        info.certSubject = cert.subject.getField('CN')?.value;
        info.certIssuer = cert.issuer.getField('CN')?.value;
        info.certValidFrom = cert.validity.notBefore?.toISOString();
        info.certValidTo = cert.validity.notAfter?.toISOString();
        info.certExpired = new Date() > cert.validity.notAfter;
      } catch (e: any) { info.certParseError = e.message; }
    }
    if (WWDR_BASE64) {
      const wwdrBuf = ensurePem(Buffer.from(WWDR_BASE64, 'base64'), 'CERTIFICATE');
      const wwdrStr = wwdrBuf.toString('utf-8');
      info.wwdrIsPem = wwdrStr.includes('-----BEGIN');
      try {
        const cert = forge.pki.certificateFromPem(wwdrStr);
        info.wwdrSubject = cert.subject.getField('CN')?.value;
        info.wwdrValidTo = cert.validity.notAfter?.toISOString();
      } catch (e: any) { info.wwdrParseError = e.message; }
    }
    if (KEY_BASE64) {
      const keyBuf = ensurePem(Buffer.from(KEY_BASE64, 'base64'), 'PRIVATE KEY');
      const keyStr = keyBuf.toString('utf-8');
      info.keyIsPem = keyStr.includes('-----BEGIN');
      info.keyHeader = keyStr.split('\n')[0];
      try {
        const key = KEY_PASSPHRASE
          ? forge.pki.decryptRsaPrivateKey(keyStr, KEY_PASSPHRASE)
          : forge.pki.privateKeyFromPem(keyStr);
        info.keyParsed = !!key;
        if (key) info.keyBits = key.n?.bitLength?.();
      } catch (e: any) { info.keyParseError = e.message; }
    }
  } catch { /* ignore */ }

  res.json(info);
});

walletPassRouter.get('/wallet-pass/test', async (_req, res) => {
  try {
    if (!isConfigured()) return res.status(501).json({ error: 'Not configured', details: { forge: !!forge, doNotZip: !!doNotZip, passTypeId: !!PASS_TYPE_ID, teamId: !!TEAM_ID, cert: !!CERT_BASE64, key: !!KEY_BASE64, wwdr: !!WWDR_BASE64 } });

    const certPem = ensurePem(Buffer.from(CERT_BASE64!, 'base64'), 'CERTIFICATE').toString('utf-8');
    const keyPem = ensurePem(Buffer.from(KEY_BASE64!, 'base64'), 'PRIVATE KEY').toString('utf-8');
    const wwdrPem = ensurePem(Buffer.from(WWDR_BASE64!, 'base64'), 'CERTIFICATE').toString('utf-8');

    const MINIMAL_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAABl0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMC4xNkRECVkAAAANSURBVBhXY/j//z8DAAj8Av6IXwboAAAAAElFTkSuQmCC',
      'base64'
    );

    const passJson = {
      formatVersion: 1,
      passTypeIdentifier: PASS_TYPE_ID,
      teamIdentifier: TEAM_ID,
      organizationName: 'Test',
      serialNumber: `test-${Date.now()}`,
      description: 'Test loyalty card',
      backgroundColor: 'rgb(0, 148, 136)',
      foregroundColor: 'rgb(255, 255, 255)',
      labelColor: 'rgb(255, 255, 255)',
      generic: {
        headerFields: [{ key: 'points', label: 'POINTS', value: '0' }],
        primaryFields: [{ key: 'balance', label: 'Loyalty Card', value: '0 points' }],
        secondaryFields: [{ key: 'value', label: 'VALUE', value: '0.00 SAR' }],
        backFields: [{ key: 'lifetime', label: 'Lifetime Points', value: '0' }],
      },
      barcodes: [{ format: 'PKBarcodeFormatQR', message: 'test-customer', messageEncoding: 'iso-8859-1' }],
    };

    const assets: Record<string, Buffer> = {
      'icon.png': MINIMAL_PNG,
      'icon@2x.png': MINIMAL_PNG,
    };

    const buffer = buildPkpass(passJson, assets, certPem, keyPem, wwdrPem);

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'inline; filename="test.pkpass"',
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  } catch (err: any) {
    console.error('[WalletPass/test] Error:', err?.message, err?.stack?.substring(0, 500));
    res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack?.substring(0, 500),
    });
  }
});

walletPassRouter.get('/wallet-pass', async (req, res) => {
  try {
    const customerId = req.query.customerId as string;
    const merchantId = req.query.merchantId as string;
    if (!customerId || !merchantId) {
      return res.status(400).json({ error: 'customerId and merchantId required' });
    }
    if (!isConfigured()) {
      return res.status(501).json({ error: 'Apple Wallet pass not configured' });
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

    const { data: stampData } = await supabaseAdmin
      .from('loyalty_stamps')
      .select('stamps, completed_cards')
      .eq('customer_id', customerId)
      .eq('merchant_id', merchantId)
      .single();

    const { data: config } = await supabaseAdmin
      .from('loyalty_config')
      .select('*')
      .eq('merchant_id', merchantId)
      .single();

    const bgColor = config?.wallet_card_bg_color || '#0D9488';
    const textColor = config?.wallet_card_text_color || '#FFFFFF';
    const cardLabel = config?.wallet_card_label || 'Loyalty Card';
    const pointsPerSar = config?.points_per_sar ?? 0.1;
    const pointValueSar = pointsPerSar > 0 ? 1 : 0.1;

    const certPem = ensurePem(Buffer.from(CERT_BASE64!, 'base64'), 'CERTIFICATE').toString('utf-8');
    const keyPem = ensurePem(Buffer.from(KEY_BASE64!, 'base64'), 'PRIVATE KEY').toString('utf-8');
    const wwdrPem = ensurePem(Buffer.from(WWDR_BASE64!, 'base64'), 'CERTIFICATE').toString('utf-8');

    const MINIMAL_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAABl0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMC4xNkRECVkAAAANSURBVBhXY/j//z8DAAj8Av6IXwboAAAAAElFTkSuQmCC',
      'base64'
    );

    const assets: Record<string, Buffer> = {
      'icon.png': MINIMAL_PNG,
      'icon@2x.png': MINIMAL_PNG,
    };

    if (config?.wallet_card_logo_url) {
      try {
        const logoRes = await fetch(config.wallet_card_logo_url);
        if (logoRes.ok) {
          const logoBuffer = Buffer.from(await logoRes.arrayBuffer());
          assets['logo.png'] = logoBuffer;
          assets['logo@2x.png'] = logoBuffer;
        }
      } catch { /* use default */ }
    }

    const passJson: Record<string, unknown> = {
      formatVersion: 1,
      passTypeIdentifier: PASS_TYPE_ID,
      teamIdentifier: TEAM_ID,
      organizationName: cardLabel,
      serialNumber: `loyalty-${merchantId}-${customerId}`,
      description: cardLabel,
      backgroundColor: hexToRgb(bgColor),
      foregroundColor: hexToRgb(textColor),
      labelColor: hexToRgb(textColor),
      generic: {
        headerFields: [{ key: 'points', label: 'POINTS', value: String(points) }],
        primaryFields: [{ key: 'balance', label: cardLabel, value: `${points} points` }],
        secondaryFields: [
          { key: 'value', label: 'VALUE', value: `${(points * pointValueSar).toFixed(2)} SAR` },
          ...(config?.stamp_enabled && stampData
            ? [{ key: 'stamps', label: 'STAMPS', value: `${stampData.stamps ?? 0} / ${config.stamp_target}` }]
            : []),
        ],
        backFields: [{ key: 'lifetime', label: 'Lifetime Points', value: String(lifetimePoints) }],
      },
      barcodes: [{ format: 'PKBarcodeFormatQR', message: customerId, messageEncoding: 'iso-8859-1' }],
    };

    const buffer = buildPkpass(passJson, assets, certPem, keyPem, wwdrPem);

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': `inline; filename="loyalty-card.pkpass"`,
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  } catch (err: any) {
    console.error('[WalletPass] Error:', err?.message, err?.stack?.substring(0, 300));
    res.status(500).json({ error: err?.message || 'Failed to generate wallet pass' });
  }
});
