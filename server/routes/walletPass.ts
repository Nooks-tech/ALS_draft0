/**
 * Apple Wallet Pass generation — using node-forge for PKCS#7 signing.
 * Signing approach mirrors passkit-generator v3 (github.com/alexandercerutti/passkit-generator).
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import * as forge from 'node-forge';
import * as crypto from 'crypto';

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

function sha1Hex(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function parseSignerKey(keyPem: string): forge.pki.rsa.PrivateKey {
  if (keyPem.includes('ENCRYPTED') || keyPem.includes('BEGIN RSA PRIVATE KEY')) {
    const key = forge.pki.decryptRsaPrivateKey(keyPem, KEY_PASSPHRASE || undefined);
    if (key) return key;
  }
  try { return forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey; } catch {}
  throw new Error('Could not parse private key (tried decrypt + PEM parse)');
}

function signManifest(manifestBuffer: Buffer): Buffer {
  const certPem = decode(CERT_BASE64!).toString('utf-8');
  const wwdrPem = decode(WWDR_BASE64!).toString('utf-8');
  const keyPem = decode(KEY_BASE64!).toString('utf-8');

  const signerCert = forge.pki.certificateFromPem(certPem);
  const wwdrCert = forge.pki.certificateFromPem(wwdrPem);
  const signerKey = parseSignerKey(keyPem);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = new forge.util.ByteStringBuffer(manifestBuffer);

  p7.addCertificate(wwdrCert);
  p7.addCertificate(signerCert);

  p7.addSigner({
    key: signerKey,
    certificate: signerCert,
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

function buildPkpass(files: Record<string, Buffer>): Promise<Buffer> {
  const manifest: Record<string, string> = {};
  for (const [name, buf] of Object.entries(files)) {
    manifest[name] = sha1Hex(buf);
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf-8');
  const signatureBuf = signManifest(manifestBuf);

  const allFiles: Record<string, Buffer> = {
    ...files,
    'manifest.json': manifestBuf,
    'signature': signatureBuf,
  };

  const yazl = require('yazl');
  return new Promise<Buffer>((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    for (const [name, data] of Object.entries(allFiles)) {
      zipfile.addBuffer(data, name, { compress: false });
    }
    zipfile.end();

    const chunks: Buffer[] = [];
    zipfile.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zipfile.outputStream.on('error', reject);
  });
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
    version: 'v11-passkit-gen-style',
  };

  try {
    const keyPem = decode(KEY_BASE64!).toString('utf-8');
    info.keyFormat = keyPem.includes('ENCRYPTED') ? 'ENCRYPTED' :
                     keyPem.includes('BEGIN RSA PRIVATE KEY') ? 'PKCS#1' : 'PKCS#8/other';
    try { parseSignerKey(keyPem); info.keyParsed = 'OK'; } catch (kErr: any) { info.keyParsed = `FAILED: ${kErr.message}`; }

    const certPem = decode(CERT_BASE64!).toString('utf-8');
    const cert = forge.pki.certificateFromPem(certPem);
    info.certSubject = cert.subject.getField('CN')?.value || '(no CN)';
    info.certIssuer = cert.issuer.getField('CN')?.value || '(no CN)';
    info.certValidFrom = cert.validity.notBefore?.toISOString();
    info.certValidTo = cert.validity.notAfter?.toISOString();

    const wwdrPem = decode(WWDR_BASE64!).toString('utf-8');
    const wwdr = forge.pki.certificateFromPem(wwdrPem);
    info.wwdrSubject = wwdr.subject.getField('CN')?.value || '(no CN)';
    info.wwdrIssuer = wwdr.issuer.getField('CN')?.value || '(no CN)';
    info.wwdrOU = wwdr.subject.getField('OU')?.value || '(no OU)';
    info.certIssuerCN = cert.issuer.getField('CN')?.value || '(no CN)';
    info.certChainMatch = (cert.issuer.getField('CN')?.value === wwdr.subject.getField('CN')?.value) ? 'YES' : 'MISMATCH - WRONG WWDR!';
    info.wwdrValidFrom = wwdr.validity.notBefore?.toISOString();
    info.wwdrValidTo = wwdr.validity.notAfter?.toISOString();

    const certOU = cert.subject.getField('OU')?.value || '';
    info.certOU = certOU;
    info.certPassTypeIdFromCert = cert.subject.getField({ type: '0.9.2342.19200300.100.1.1' })?.value || '(no UID field)';
    info.envPassTypeId = PASS_TYPE_ID;
    info.envTeamId = TEAM_ID;
    info.passTypeIdMatch = info.certPassTypeIdFromCert === PASS_TYPE_ID ? 'YES' : 'MISMATCH!';
    info.teamIdMatch = certOU === TEAM_ID ? 'YES' : 'MISMATCH!';

    info.digestAlgorithm = 'sha1';

    try {
      const testManifest = Buffer.from('{"test":"data"}', 'utf-8');
      const testSig = signManifest(testManifest);
      info.testSignatureSize = testSig.length;
      info.testSignatureFirstByte = '0x' + testSig[0].toString(16);
    } catch (sigErr: any) {
      info.testSignatureError = sigErr.message;
    }
  } catch (e: any) {
    info.error = e.message;
  }

  res.json(info);
});

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
  const passObj: Record<string, unknown> = {
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
  };

  return Buffer.from(JSON.stringify(passObj), 'utf-8');
}

walletPassRouter.get('/wallet-pass/test', async (_req, res) => {
  try {
    if (!isConfigured()) return res.status(501).json({ error: 'Not configured' });

    const passJson = buildPassJson({
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

    const files: Record<string, Buffer> = {
      'icon.png': ICON_1X,
      'icon@2x.png': ICON_2X,
      'icon@3x.png': ICON_3X,
      'pass.json': passJson,
    };

    const pkpass = await buildPkpass(files);

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
      .eq('merchant_id', merchantId).single();

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

    const passJson = buildPassJson({
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

    files['pass.json'] = passJson;

    const pkpass = await buildPkpass(files);

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
