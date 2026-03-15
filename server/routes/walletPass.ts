/**
 * Apple Wallet Pass generation for loyalty cards.
 * Uses OpenSSL for PKCS#7 signing (most reliable for Apple Wallet).
 * Uses SHA-1 for manifest hashes (Apple's specified format).
 */
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';

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
  return !!(doNotZip && PASS_TYPE_ID && TEAM_ID && CERT_BASE64 && KEY_BASE64 && WWDR_BASE64);
}

function ensurePem(buf: Buffer, type: string): Buffer {
  const str = buf.toString('utf-8');
  if (str.includes('-----BEGIN')) return buf;
  const b64 = buf.toString('base64');
  const lines = b64.match(/.{1,64}/g)!.join('\n');
  return Buffer.from(`-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`);
}

function signWithOpenSSL(manifestBuf: Buffer, certBuf: Buffer, keyBuf: Buffer, wwdrBuf: Buffer): Buffer {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'pkpass-'));
  const certPath = path.join(tmpDir, 'cert.pem');
  const keyPath = path.join(tmpDir, 'key.pem');
  const wwdrPath = path.join(tmpDir, 'wwdr.pem');
  const manifestPath = path.join(tmpDir, 'manifest.json');
  const sigPath = path.join(tmpDir, 'signature');

  try {
    writeFileSync(certPath, certBuf);
    writeFileSync(keyPath, keyBuf);
    writeFileSync(wwdrPath, wwdrBuf);
    writeFileSync(manifestPath, manifestBuf);

    const passinArg = KEY_PASSPHRASE ? `-passin pass:${KEY_PASSPHRASE}` : '';

    execSync(
      `openssl smime -binary -sign -certfile "${wwdrPath}" -signer "${certPath}" -inkey "${keyPath}" -in "${manifestPath}" -out "${sigPath}" -outform DER ${passinArg}`,
      { stdio: 'pipe' }
    );

    return readFileSync(sigPath);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function buildPkpass(passJson: Record<string, unknown>, assets: Record<string, Buffer>, certBuf: Buffer, keyBuf: Buffer, wwdrBuf: Buffer): Buffer {
  const files: Record<string, Buffer> = { ...assets };
  files['pass.json'] = Buffer.from(JSON.stringify(passJson));

  const manifest: Record<string, string> = {};
  for (const [name, buf] of Object.entries(files)) {
    manifest[name] = createHash('sha1').update(buf).digest('hex');
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  const signatureBuf = signWithOpenSSL(manifestBuf, certBuf, keyBuf, wwdrBuf);

  const zipEntries = [
    ...Object.entries(files).map(([p, data]) => ({ path: p, data })),
    { path: 'manifest.json', data: manifestBuf },
    { path: 'signature', data: signatureBuf },
  ];

  return Buffer.from(doNotZip.toArray(zipEntries));
}

// ─── Routes ───

walletPassRouter.get('/wallet-pass/check', (_req, res) => {
  if (!isConfigured()) return res.status(501).json({ available: false });
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
    pkPassAvailable: isConfigured(),
    manifestHash: 'SHA-1',
    signatureMethod: 'OpenSSL smime',
  };

  let forge: any;
  try { forge = require('node-forge'); } catch {}

  try {
    if (CERT_BASE64 && forge) {
      const certBuf = ensurePem(Buffer.from(CERT_BASE64, 'base64'), 'CERTIFICATE');
      const certStr = certBuf.toString('utf-8');
      info.certIsPem = certStr.includes('-----BEGIN');
      info.certFirst20 = certStr.substring(0, 50);
      try {
        const cert = forge.pki.certificateFromPem(certStr);
        info.certSubject = cert.subject.getField('CN')?.value;
        info.certIssuer = cert.issuer.getField('CN')?.value;
        info.certValidFrom = cert.validity.notBefore?.toISOString();
        info.certValidTo = cert.validity.notAfter?.toISOString();
        info.certExpired = new Date() > cert.validity.notAfter;
      } catch (e: any) { info.certParseError = e.message; }
    }
    if (WWDR_BASE64 && forge) {
      const wwdrBuf = ensurePem(Buffer.from(WWDR_BASE64, 'base64'), 'CERTIFICATE');
      const wwdrStr = wwdrBuf.toString('utf-8');
      info.wwdrIsPem = wwdrStr.includes('-----BEGIN');
      info.wwdrFirst20 = wwdrStr.substring(0, 50);
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
      info.keyFirst20 = keyStr.substring(0, 50);
    }
  } catch { /* ignore */ }

  // Test OpenSSL availability
  try {
    const ver = execSync('openssl version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    info.opensslVersion = ver;
  } catch (e: any) {
    info.opensslAvailable = false;
    info.opensslError = e.message;
  }

  res.json(info);
});

walletPassRouter.get('/wallet-pass/test', async (_req, res) => {
  try {
    if (!isConfigured()) return res.status(501).json({ error: 'Not configured' });

    const certBuf = ensurePem(Buffer.from(CERT_BASE64!, 'base64'), 'CERTIFICATE');
    const keyBuf = ensurePem(Buffer.from(KEY_BASE64!, 'base64'), 'PRIVATE KEY');
    const wwdrBuf = ensurePem(Buffer.from(WWDR_BASE64!, 'base64'), 'CERTIFICATE');

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

    const buffer = buildPkpass(passJson, assets, certBuf, keyBuf, wwdrBuf);

    res.json({
      success: true,
      pkpassSize: buffer.length,
      passJson,
      manifestSample: (() => {
        const files: Record<string, Buffer> = { ...assets };
        files['pass.json'] = Buffer.from(JSON.stringify(passJson));
        const m: Record<string, string> = {};
        for (const [name, buf] of Object.entries(files)) {
          m[name] = createHash('sha1').update(buf).digest('hex');
        }
        return m;
      })(),
      pkpassBase64: buffer.toString('base64'),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
      stderr: err.stderr?.toString?.() || null,
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

    const signerCert = ensurePem(Buffer.from(CERT_BASE64!, 'base64'), 'CERTIFICATE');
    const signerKey = ensurePem(Buffer.from(KEY_BASE64!, 'base64'), 'PRIVATE KEY');
    const wwdr = ensurePem(Buffer.from(WWDR_BASE64!, 'base64'), 'CERTIFICATE');

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

    // Apple Wallet colors must be rgb() format, not hex
    const hexToRgb = (hex: string): string => {
      const h = hex.replace('#', '');
      const r = parseInt(h.substring(0, 2), 16);
      const g = parseInt(h.substring(2, 4), 16);
      const b = parseInt(h.substring(4, 6), 16);
      if (isNaN(r) || isNaN(g) || isNaN(b)) return hex;
      return `rgb(${r}, ${g}, ${b})`;
    };

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

    const buffer = buildPkpass(passJson, assets, signerCert, signerKey, wwdr);

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Content-Disposition': `inline; filename="loyalty-card.pkpass"`,
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  } catch (err: any) {
    console.error('[WalletPass] Error:', err?.message, err?.stderr?.toString?.() || '', err?.stack?.substring(0, 300));
    res.status(500).json({ error: err?.message || 'Failed to generate wallet pass' });
  }
});
