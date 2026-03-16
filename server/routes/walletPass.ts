/**
 * Apple Wallet Pass generation — manual implementation (no passkit-generator).
 * Uses node-forge for PKCS#7 signing and yazl for zip creation.
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

const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAABl0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMC4xNkRECVkAAAANSURBVBhXY/j//z8DAAj8Av6IXwboAAAAAElFTkSuQmCC',
  'base64'
);

function sha1Hex(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function getPrivateKey(): forge.pki.rsa.PrivateKey {
  const keyPem = decode(KEY_BASE64!).toString('utf-8');
  if (keyPem.includes('-----BEGIN RSA PRIVATE KEY-----')) {
    const passphrase = KEY_PASSPHRASE || undefined;
    const key = forge.pki.decryptRsaPrivateKey(keyPem, passphrase);
    if (!key) throw new Error('Failed to parse RSA private key');
    return key;
  }
  return forge.pki.privateKeyFromPem(keyPem);
}

function signManifest(manifestBuffer: Buffer): Buffer {
  const certPem = decode(CERT_BASE64!).toString('utf-8');
  const wwdrPem = decode(WWDR_BASE64!).toString('utf-8');

  const signerCert = forge.pki.certificateFromPem(certPem);
  const wwdrCert = forge.pki.certificateFromPem(wwdrPem);
  const signerKey = getPrivateKey();

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
    manifest[name] = sha1Hex(buf);
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf-8');
  const signatureBuf = signManifest(manifestBuf);

  const allFiles: Record<string, Buffer> = {
    ...files,
    'manifest.json': manifestBuf,
    'signature': signatureBuf,
  };

  const parts: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;
  const entries = Object.entries(allFiles);

  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header sig
    localHeader.writeUInt16LE(20, 4);          // version needed (2.0)
    localHeader.writeUInt16LE(0, 6);           // general purpose bit flag
    localHeader.writeUInt16LE(0, 8);           // compression: stored
    localHeader.writeUInt16LE(0, 10);          // mod time
    localHeader.writeUInt16LE(0, 12);          // mod date
    const crc = crc32(data);
    localHeader.writeInt32LE(crc, 14);         // crc-32
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26); // file name length
    localHeader.writeUInt16LE(0, 28);          // extra field length
    nameBytes.copy(localHeader, 30);

    const cdEntry = Buffer.alloc(46 + nameBytes.length);
    cdEntry.writeUInt32LE(0x02014b50, 0);  // central directory header sig
    cdEntry.writeUInt16LE(20, 4);           // version made by
    cdEntry.writeUInt16LE(20, 6);           // version needed
    cdEntry.writeUInt16LE(0, 8);            // general purpose bit flag
    cdEntry.writeUInt16LE(0, 10);           // compression: stored
    cdEntry.writeUInt16LE(0, 12);           // mod time
    cdEntry.writeUInt16LE(0, 14);           // mod date
    cdEntry.writeInt32LE(crc, 16);          // crc-32
    cdEntry.writeUInt32LE(data.length, 20); // compressed size
    cdEntry.writeUInt32LE(data.length, 24); // uncompressed size
    cdEntry.writeUInt16LE(nameBytes.length, 28); // file name length
    cdEntry.writeUInt16LE(0, 30);           // extra field length
    cdEntry.writeUInt16LE(0, 32);           // file comment length
    cdEntry.writeUInt16LE(0, 34);           // disk number start
    cdEntry.writeUInt16LE(0, 36);           // internal attrs
    cdEntry.writeUInt32LE(0, 38);           // external attrs
    cdEntry.writeUInt32LE(offset, 42);      // relative offset
    nameBytes.copy(cdEntry, 46);

    parts.push(localHeader, data);
    centralDir.push(cdEntry);
    offset += localHeader.length + data.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const cd of centralDir) {
    parts.push(cd);
    cdSize += cd.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);        // end of central dir sig
  eocd.writeUInt16LE(0, 4);                  // disk number
  eocd.writeUInt16LE(0, 6);                  // disk with start of cd
  eocd.writeUInt16LE(entries.length, 8);     // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);    // total entries
  eocd.writeUInt32LE(cdSize, 12);            // size of central directory
  eocd.writeUInt32LE(cdOffset, 16);          // offset of central directory
  eocd.writeUInt16LE(0, 20);                 // comment length
  parts.push(eocd);

  return Buffer.concat(parts);
}

const CRC_TABLE = new Int32Array(256);
(function initCrcTable() {
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[n] = c;
  }
})();

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) | 0;
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
    version: 'v6-manual-build',
  };

  try {
    const key = getPrivateKey();
    info.keyParsed = key ? 'OK' : 'FAILED';

    const certPem = decode(CERT_BASE64!).toString('utf-8');
    const cert = forge.pki.certificateFromPem(certPem);
    info.certSubject = cert.subject.getField('CN')?.value || '(no CN)';
    info.certIssuer = cert.issuer.getField('CN')?.value || '(no CN)';
    info.certValidFrom = cert.validity.notBefore?.toISOString();
    info.certValidTo = cert.validity.notAfter?.toISOString();

    const wwdrPem = decode(WWDR_BASE64!).toString('utf-8');
    const wwdr = forge.pki.certificateFromPem(wwdrPem);
    info.wwdrSubject = wwdr.subject.getField('CN')?.value || '(no CN)';
    info.wwdrOU = wwdr.subject.getField('OU')?.value || '(no OU)';
    info.wwdrValidFrom = wwdr.validity.notBefore?.toISOString();
    info.wwdrValidTo = wwdr.validity.notAfter?.toISOString();

    info.digestAlgorithm = 'sha256';
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
      'icon.png': MINIMAL_PNG,
      'icon@2x.png': MINIMAL_PNG,
      'pass.json': passJson,
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
      .eq('merchant_id', merchantId).single();

    const bgColor = config?.wallet_card_bg_color || '#0D9488';
    const textColor = config?.wallet_card_text_color || '#FFFFFF';
    const cardLabel = config?.wallet_card_label || 'Loyalty Card';
    const pointsPerSar = config?.points_per_sar ?? 0.1;
    const pointValueSar = pointsPerSar > 0 ? 1 : 0.1;

    const files: Record<string, Buffer> = {
      'icon.png': MINIMAL_PNG,
      'icon@2x.png': MINIMAL_PNG,
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

    const pkpass = buildPkpass(files);

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
