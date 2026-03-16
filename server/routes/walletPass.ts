/**
 * Apple Wallet Pass generation — uses openssl for signing (gold standard).
 * ZIP created with yazl. No node-forge signing dependency.
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yazl from 'yazl';

export const walletPassRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const PASS_TYPE_ID = process.env.APPLE_PASS_TYPE_ID || '';
const TEAM_ID = process.env.APPLE_PASS_TEAM_ID || '';
const CERT_BASE64 = process.env.APPLE_PASS_CERT_BASE64 || '';
const KEY_BASE64 = process.env.APPLE_PASS_KEY_BASE64 || '';
const KEY_PASSPHRASE = process.env.APPLE_PASS_KEY_PASSPHRASE || '';

// Official Apple WWDR G4 certificate (downloaded from https://www.apple.com/certificateauthority/)
// Hardcoded to prevent mismatched certificate issues.
const APPLE_WWDR_G4_PEM = `-----BEGIN CERTIFICATE-----
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

function isConfigured() {
  return !!(PASS_TYPE_ID && TEAM_ID && CERT_BASE64 && KEY_BASE64);
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

function sha1Hex(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
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
      headerFields: [{ key: 'points', label: 'POINTS', value: String(opts.points) }],
      primaryFields: [{ key: 'balance', label: opts.cardLabel, value: `${opts.points} points` }],
      secondaryFields: [
        { key: 'value', label: 'VALUE', value: `${(opts.points * opts.pointValueSar).toFixed(2)} SAR` },
        ...(opts.stamps ? [{ key: 'stamps', label: 'STAMPS', value: `${opts.stamps.current} / ${opts.stamps.target}` }] : []),
      ],
      auxiliaryFields: [],
      backFields: [{ key: 'lifetime', label: 'Lifetime Points', value: String(opts.lifetimePoints) }],
    },
    barcodes: [{ format: 'PKBarcodeFormatQR', message: opts.customerId, messageEncoding: 'iso-8859-1' }],
  }));
}

function signWithOpenSSL(manifestBuf: Buffer): Buffer {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkpass-'));
  try {
    const certPath = path.join(tmpDir, 'signerCert.pem');
    const keyPath = path.join(tmpDir, 'signerKey.pem');
    const wwdrPath = path.join(tmpDir, 'wwdr.pem');
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const sigPath = path.join(tmpDir, 'signature');

    fs.writeFileSync(certPath, decode(CERT_BASE64));
    fs.writeFileSync(keyPath, decode(KEY_BASE64));
    fs.writeFileSync(wwdrPath, APPLE_WWDR_G4_PEM);
    fs.writeFileSync(manifestPath, manifestBuf);

    const args = [
      'smime', '-sign', '-binary',
      '-in', manifestPath,
      '-out', sigPath,
      '-outform', 'DER',
      '-signer', certPath,
      '-inkey', keyPath,
      '-certfile', wwdrPath,
    ];

    if (KEY_PASSPHRASE) {
      args.push('-passin', `pass:${KEY_PASSPHRASE}`);
    }

    execFileSync('openssl', args, { timeout: 10000 });
    return fs.readFileSync(sigPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function createPassBuffer(files: Record<string, Buffer>): Promise<Buffer> {
  const manifest: Record<string, string> = {};
  for (const [name, buf] of Object.entries(files)) {
    manifest[name] = sha1Hex(buf);
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  const signatureBuf = signWithOpenSSL(manifestBuf);

  return new Promise<Buffer>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, buf] of Object.entries(files)) {
      zip.addBuffer(buf, name, { compress: false });
    }
    zip.addBuffer(manifestBuf, 'manifest.json', { compress: false });
    zip.addBuffer(signatureBuf, 'signature', { compress: false });
    zip.end();

    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
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
    version: 'v17-correct-wwdr-g4',
  };

  try {
    // Check openssl availability
    const opensslVersion = execFileSync('openssl', ['version'], { timeout: 5000 }).toString().trim();
    info.opensslVersion = opensslVersion;

    // Verify cert and key
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-'));
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    const wwdrPath = path.join(tmpDir, 'wwdr.pem');
    fs.writeFileSync(certPath, decode(CERT_BASE64));
    fs.writeFileSync(keyPath, decode(KEY_BASE64));
    fs.writeFileSync(wwdrPath, APPLE_WWDR_G4_PEM);

    const certInfo = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-subject', '-dates'], { timeout: 5000 }).toString();
    info.certInfo = certInfo.trim();

    const wwdrInfo = execFileSync('openssl', ['x509', '-in', wwdrPath, '-noout', '-subject', '-dates', '-fingerprint', '-sha256'], { timeout: 5000 }).toString();
    info.wwdrInfo = wwdrInfo.trim();

    // Test signing
    const testManifest = Buffer.from('{"test":"ok"}');
    const testSig = signWithOpenSSL(testManifest);
    info.testSigSize = testSig.length;

    // Generate test pass and inspect
    const testPass = await createPassBuffer({
      'icon.png': ICON_1X,
      'icon@2x.png': ICON_2X,
      'icon@3x.png': ICON_3X,
      'pass.json': buildPassJson({
        serialNumber: 'debug-test',
        description: 'Debug',
        organizationName: 'Debug',
        bgColor: 'rgb(0,0,0)',
        fgColor: 'rgb(255,255,255)',
        labelColor: 'rgb(255,255,255)',
        cardLabel: 'Debug',
        points: 0, lifetimePoints: 0, pointValueSar: 0.1,
        customerId: 'debug',
      }),
    });
    info.testPassSize = testPass.length;

    // Verify the pass signature using openssl on server
    const vDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
    const passZipPath = path.join(vDir, 'test.pkpass');
    fs.writeFileSync(passZipPath, testPass);

    const AdmZip = require('adm-zip');
    const zip = new AdmZip(testPass);
    const mBuf = zip.getEntry('manifest.json')!.getData();
    const sBuf = zip.getEntry('signature')!.getData();
    const mPath = path.join(vDir, 'manifest.json');
    const sPath = path.join(vDir, 'signature');
    fs.writeFileSync(mPath, mBuf);
    fs.writeFileSync(sPath, sBuf);

    try {
      const verifyResult = execFileSync('openssl', [
        'smime', '-verify', '-inform', 'DER',
        '-in', sPath, '-content', mPath, '-noverify',
      ], { timeout: 5000 }).toString();
      info.signatureVerification = 'PASS - ' + verifyResult.substring(0, 50);
    } catch (e: any) {
      info.signatureVerification = 'FAIL - ' + (e.stderr?.toString() || e.message).substring(0, 200);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(vDir, { recursive: true, force: true });
  } catch (e: any) {
    info.error = e.message;
    info.stderr = e.stderr?.toString()?.substring(0, 300);
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

    const pkpass = await createPassBuffer(files);

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Length': String(pkpass.length),
    });
    res.end(pkpass);
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

    const pkpass = await createPassBuffer(files);

    if (req.query.format === 'base64') {
      return res.json({ base64: pkpass.toString('base64'), size: pkpass.length });
    }

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Length': String(pkpass.length),
    });
    res.end(pkpass);
  } catch (err: any) {
    console.error('[WalletPass]', err?.message, err?.stack?.substring(0, 300));
    res.status(500).json({ error: err?.message || 'Failed to generate wallet pass' });
  }
});
