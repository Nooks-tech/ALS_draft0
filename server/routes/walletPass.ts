/**
 * Apple Wallet Pass generation for loyalty cards.
 * Signing logic matches @nwpr/pass-js signManifest-forge.js exactly.
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

function isConfigured() {
  return !!(forge && doNotZip && PASS_TYPE_ID && TEAM_ID && CERT_BASE64 && KEY_BASE64);
}

function decodePem(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  const str = buf.toString('utf-8');
  if (str.includes('-----BEGIN')) return str;
  const lines = buf.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

function decodeKey(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  const str = buf.toString('utf-8');
  if (str.includes('-----BEGIN')) return str;
  const lines = buf.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Signing logic copied from @nwpr/pass-js signManifest-forge.js
 * Key differences from our previous attempt:
 * - key is passed as PEM string (forge.pki.privateKeyToPem), not raw key object
 * - signer cert added FIRST, then WWDR cert
 * - WWDR G4 cert is built into @nwpr/pass-js; we use the same one
 */
const WWDR_G4_PEM = `-----BEGIN CERTIFICATE-----
MIIEVTCCAz2gAwIBAgIUE9x3lVJx5T3GMujM/+Uh88zFztIwDQYJKoZIhvcNAQEL
BQAwYjELMAkGA1UEBhMCVVMxEzARBgNVBAoTCkFwcGxlIEluYy4xJjAkBgNVBAsT
HUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRYwFAYDVQQDEw1BcHBsZSBS
b290IENBMB4XDTIwMTIxNjE5MzYwNFoXDTMwMTIxMDAwMDAwMFowdTFEMEIGA1UE
Aww7QXBwbGUgV29ybGR3aWRlIERldmVsb3BlciBSZWxhdGlvbnMgQ2VydGlmaWNh
dGlvbiBBdXRob3JpdHkxCzAJBgNVBAsMAkc0MRMwEQYDVQQKDApBcHBsZSBJbmMu
MQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANAf
eKp6JzKwRl/nF3bYoJ0OKY6tPTKlxGs3yeRBkWq3eXFdDDQEYHX3rkOPR8SGHgjo
v9Y5Ui8eZ/xx8YJtPH4GUnadLLzVQ+mxtLxAOnhRXVGhJeG+bJGdayFZGEHVD41t
QSo5SiHgkJ9OE0/QjJoyuNdqkh4laqQyziIZhQVg3AJK8lrrd3kCfcCXVGySjnYB
5kaP5eYq+6KwrRitbTOFOCOL6oqW7Z+uZk+jDEAnbZXQYojZQykn/e2kv1MukBVl
PNkuYmQzHWxq3Y4hqqRfFcYw7V/mjDaSlLfcOQIA+2SM1AyB8j/VNJeHdSbCb64D
YyEMe9QbsWLFApy9/a8CAwEAAaOB7zCB7DASBgNVHRMBAf8ECDAGAQH/AgEAMB8G
A1UdIwQYMBaAFCvQaUeUdgn+9GuNLkCm90dNfwheMEQGCCsGAQUFBwEBBDgwNjA0
BggrBgEFBQcwAYYoaHR0cDovL29jc3AuYXBwbGUuY29tL29jc3AwMy1hcHBsZXJv
b3RjYTAuBgNVHR8EJzAlMCOgIaAfhh1odHRwOi8vY3JsLmFwcGxlLmNvbS9yb290
LmNybDAdBgNVHQ4EFgQUW9n6HeeaGgujmXYiUIY+kchbd6gwDgYDVR0PAQH/BAQD
AgEGMBAGCiqGSIb3Y2QGAgEEAgUAMA0GCSqGSIb3DQEBCwUAA4IBAQA/Vj2e5bbD
eeZFIGi9v3OLLBKeAuOugCKMBB7DUshwgKj7zqew1UJEggOCTwb8O0kU+9h0UoWv
p50h5wESA5/NQFjQAde/MoMrU1goPO6cn1R2PWQnxn6NHThNLa6B5rmluJyJlPef
x4elUWY0GzlxOSTjh2fvpbFoe4zuPfeutnvi0v/fYcZqdUmVIkSoBPyUuAsuORFJ
EtHlgepZAE9bPFo22noicwkJac3AfOriJP6YRLj477JxPxpd1F1+M02cHSS+APCQ
A1iZQT0xWmJArzmoUUOSqwSonMJNsUvSq3xKX+udO7xPiEAGE/+QF4oIRynoYpgp
pU8RBWk6z/Kf
-----END CERTIFICATE-----`;

function signManifest(manifestJson: string, certPem: string, keyPem: string): Buffer {
  const certificate = forge.pki.certificateFromPem(certPem);
  const wwdrCert = forge.pki.certificateFromPem(WWDR_G4_PEM);

  let key: any;
  if (KEY_PASSPHRASE) {
    key = forge.pki.decryptRsaPrivateKey(keyPem, KEY_PASSPHRASE);
  } else {
    key = forge.pki.privateKeyFromPem(keyPem);
  }
  if (!key) throw new Error('Failed to parse private key');

  const p7 = forge.pkcs7.createSignedData();
  p7.content = manifestJson;
  p7.addCertificate(certificate);
  p7.addCertificate(wwdrCert);
  p7.addSigner({
    key: forge.pki.privateKeyToPem(key),
    certificate,
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
): Buffer {
  const files: Record<string, Buffer> = { ...assets };
  files['pass.json'] = Buffer.from(JSON.stringify(passJson));

  const manifest: Record<string, string> = {};
  for (const [name, buf] of Object.entries(files)) {
    manifest[name] = createHash('sha1').update(buf).digest('hex');
  }
  const manifestJson = JSON.stringify(manifest);
  const manifestBuf = Buffer.from(manifestJson);
  const signatureBuf = signManifest(manifestJson, certPem, keyPem);

  const zipEntries = [
    ...Object.entries(files).map(([p, data]) => ({ path: p, data })),
    { path: 'manifest.json', data: manifestBuf },
    { path: 'signature', data: signatureBuf },
  ];

  return Buffer.from(doNotZip.toArray(zipEntries));
}

const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAABl0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMC4xNkRECVkAAAANSURBVBhXY/j//z8DAAj8Av6IXwboAAAAAElFTkSuQmCC',
  'base64'
);

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
    keyPassphraseSet: !!KEY_PASSPHRASE,
    configured: isConfigured(),
    version: 'v3-nwpr-signing',
  };

  try {
    const certPem = decodePem(CERT_BASE64!);
    const keyPem = decodeKey(KEY_BASE64!);
    const cert = forge.pki.certificateFromPem(certPem);
    info.certSubject = cert.subject.getField('CN')?.value;
    info.certValidTo = cert.validity.notAfter?.toISOString();
    info.certExpired = new Date() > cert.validity.notAfter;

    const key = KEY_PASSPHRASE
      ? forge.pki.decryptRsaPrivateKey(keyPem, KEY_PASSPHRASE)
      : forge.pki.privateKeyFromPem(keyPem);
    info.keyParsed = !!key;
    if (key) info.keyBits = key.n?.bitLength?.();
    info.keyAsPem = !!forge.pki.privateKeyToPem(key);
  } catch (e: any) { info.parseError = e.message; }

  res.json(info);
});

walletPassRouter.get('/wallet-pass/test', async (_req, res) => {
  try {
    if (!isConfigured()) return res.status(501).json({ error: 'Not configured' });

    const certPem = decodePem(CERT_BASE64!);
    const keyPem = decodeKey(KEY_BASE64!);

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

    const buffer = buildPkpass(passJson, { 'icon.png': MINIMAL_PNG, 'icon@2x.png': MINIMAL_PNG }, certPem, keyPem);

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': 'inline; filename="test.pkpass"',
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  } catch (err: any) {
    console.error('[WalletPass/test]', err?.message, err?.stack?.substring(0, 500));
    res.status(500).json({ error: err.message });
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

    const certPem = decodePem(CERT_BASE64!);
    const keyPem = decodeKey(KEY_BASE64!);

    const assets: Record<string, Buffer> = { 'icon.png': MINIMAL_PNG, 'icon@2x.png': MINIMAL_PNG };

    if (config?.wallet_card_logo_url) {
      try {
        const logoRes = await fetch(config.wallet_card_logo_url);
        if (logoRes.ok) {
          const logoBuf = Buffer.from(await logoRes.arrayBuffer());
          assets['logo.png'] = logoBuf;
          assets['logo@2x.png'] = logoBuf;
        }
      } catch { /* skip */ }
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

    const buffer = buildPkpass(passJson, assets, certPem, keyPem);

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
