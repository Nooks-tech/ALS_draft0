/**
 * Apple Wallet Pass generation + web service for live updates.
 * Signing via openssl, ZIP via yazl, push via HTTP/2 APNs.
 */
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http2 from 'http2';
import * as os from 'os';
import * as path from 'path';
import yazl from 'yazl';
import * as zlib from 'zlib';

export const walletPassRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const PASS_TYPE_ID = process.env.APPLE_PASS_TYPE_ID || '';
const TEAM_ID = process.env.APPLE_PASS_TEAM_ID || '';

const SIGNER_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIGIDCCBQigAwIBAgIQYSoGtD9Lx3AckALdz8XTEzANBgkqhkiG9w0BAQsFADB1
MUQwQgYDVQQDDDtBcHBsZSBXb3JsZHdpZGUgRGV2ZWxvcGVyIFJlbGF0aW9ucyBD
ZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTELMAkGA1UECwwCRzQxEzARBgNVBAoMCkFw
cGxlIEluYy4xCzAJBgNVBAYTAlVTMB4XDTI2MDMxNjE3MjYzOVoXDTI3MDQxNTE3
MjYzOFowgZgxKDAmBgoJkiaJk/IsZAEBDBhwYXNzLnNwYWNlLm5vb2tzLmxveWFs
dHkxLzAtBgNVBAMMJlBhc3MgVHlwZSBJRDogcGFzcy5zcGFjZS5ub29rcy5sb3lh
bHR5MRMwEQYDVQQLDAo0S1VKOURGWjhDMRkwFwYDVQQKDBBBYmR1bGxhaCBBbHNh
ZWRpMQswCQYDVQQGEwJTQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AKZ/YrI0mhHB+zgO5IjLg47qp+Es62/SysK+JiSb5SvUYhr5rE/h3Xok84zlaANN
lVmm9chbh1gY6pv3LVB3iR1q00zYNyBiSgl2C7p1mPE1dVJaKakF0tML069T3pGc
8egSu0B7penRY8xX+ys9gP2tOCFq8tUzD4mYDHbFBEHtkeLq50T++JixfI2M6EOO
AjHtvgIdkzWrPusXOOg3RNyJApsUFd9NTjYSOY/SokyLpsoT5djTaiSF1zYQBXvo
cRwFTxPycXqzDTfxHJNcT5qbNFynQ0Cf3aGCPVubL8mPyHDQ5p3QuR1i0BHe5m6x
rFd5yoD/sGl4bUxI3qmJZykCAwEAAaOCAoYwggKCMAwGA1UdEwEB/wQCMAAwHwYD
VR0jBBgwFoAUW9n6HeeaGgujmXYiUIY+kchbd6gwcAYIKwYBBQUHAQEEZDBiMC0G
CCsGAQUFBzAChiFodHRwOi8vY2VydHMuYXBwbGUuY29tL3d3ZHJnNC5kZXIwMQYI
KwYBBQUHMAGGJWh0dHA6Ly9vY3NwLmFwcGxlLmNvbS9vY3NwMDMtd3dkcmc0MDQw
ggEeBgNVHSAEggEVMIIBETCCAQ0GCSqGSIb3Y2QFATCB/zCBwwYIKwYBBQUHAgIw
gbYMgbNSZWxpYW5jZSBvbiB0aGlzIGNlcnRpZmljYXRlIGJ5IGFueSBwYXJ0eSBh
c3N1bWVzIGFjY2VwdGFuY2Ugb2YgdGhlIHRoZW4gYXBwbGljYWJsZSBzdGFuZGFy
ZCB0ZXJtcyBhbmQgY29uZGl0aW9ucyBvZiB1c2UsIGNlcnRpZmljYXRlIHBvbGlj
eSBhbmQgY2VydGlmaWNhdGlvbiBwcmFjdGljZSBzdGF0ZW1lbnRzLjA3BggrBgEF
BQcCARYraHR0cHM6Ly93d3cuYXBwbGUuY29tL2NlcnRpZmljYXRlYXV0aG9yaXR5
LzAeBgNVHSUEFzAVBggrBgEFBQcDAgYJKoZIhvdjZAQOMDIGA1UdHwQrMCkwJ6Al
oCOGIWh0dHA6Ly9jcmwuYXBwbGUuY29tL3d3ZHJnNC02LmNybDAdBgNVHQ4EFgQU
Eux5He8GBPhAMJfTfxL1c6mkEb0wDgYDVR0PAQH/BAQDAgeAMCgGCiqGSIb3Y2QG
ARAEGgwYcGFzcy5zcGFjZS5ub29rcy5sb3lhbHR5MBAGCiqGSIb3Y2QGAwIEAgUA
MA0GCSqGSIb3DQEBCwUAA4IBAQAwDRRWk5VQauU4RuvjeIs1XOFd1hgyy5L9zCPM
c+sjThjernpKlFKo2bemlTjJ3XZNGbKBZ+NPC7YRrrQAk1hwzVnRHsnvDC28d+m8
o0/XRwazi/WDjii7wOO/Cu9N8XXciDdqcXp6MgwiaZKjmhc8KLU4GyPQtggDAdsl
+1y3QS7FZKCLRwJMav2jsXkXpXqvRxjE63E3cX23BLu6HEQUnRYHZoxOk6ItuWHq
vUZZ0ALxi8swUrLOE92usvoCcs7h7MfEWR7Y7449OR4T6162Y7Q94VKt8t1Wlg18
7d8QaCyYE0Eodl5o9c4By7rk6lsJRQAL5BnxfDhT0ryP9+dW
-----END CERTIFICATE-----`;

const SIGNER_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCmf2KyNJoRwfs4
DuSIy4OO6qfhLOtv0srCviYkm+Ur1GIa+axP4d16JPOM5WgDTZVZpvXIW4dYGOqb
9y1Qd4kdatNM2DcgYkoJdgu6dZjxNXVSWimpBdLTC9OvU96RnPHoErtAe6Xp0WPM
V/srPYD9rTghavLVMw+JmAx2xQRB7ZHi6udE/viYsXyNjOhDjgIx7b4CHZM1qz7r
FzjoN0TciQKbFBXfTU42EjmP0qJMi6bKE+XY02okhdc2EAV76HEcBU8T8nF6sw03
8RyTXE+amzRcp0NAn92hgj1bmy/Jj8hw0Oad0LkdYtAR3uZusaxXecqA/7BpeG1M
SN6piWcpAgMBAAECggEACcjnuHhd65g+VtONO7rWHvKMbi/RIE+/icVaAYHF7Jb9
Mv+kUEeCWBjO1WNwAu2uzseAn0c9w4AnXYYfvCBiRv/NrjDwwG72UesFkm4x0E8n
d3EEDMJiWvPRe3bO2DjkgJKFPatmm0CqgEpVYPuq1n21FEWwQrZO/fOZG+vFLcib
pcGCpLzp0Cwc2PWBYmHnKE9Io49rUB0Gm4Ye7BwB6pwHIR+02TgSJyB5Mlg8djTO
O1hp98Qa0J2xt1AORefai0d2Tu3M4OWIUu3oaqpHL+Vs161+CQlMwVPkut7G0223
vthc5grcjI8DoWfQSnNxzmemORUiYaQtlzjF+I/7eQKBgQDXk5DP0Y+FsWuptpMp
ogLEgv0N6e2LUx3rJ4cK2adcD0DZrJ3haSWOXSoyb9TX1TvG6UGc71x2gR52Yaui
P17MHMITBWdzw0zq8W4JfvAMOlfEwfOsRXCBFTsiDje80akREzvaotmwwLiXmu+J
qOGjL/htWVGSdS8Wz6r+Nnf2jQKBgQDFt9ybgWxJyZmSS4DItVUIsc1dHrsW54w/
wP0wu8gKIKtQTbAAFwukYg3LDOLq5/TzcWD4Ttst8u6Enzu0KdGQ2T4k3eom+s2T
eOmLah60jwyVlW2m1PGggKtWAkeWDLPj5Qk3Sk9crnL5MVjd3lLTsO4YrY4uhQQH
qbDXJ6nqDQKBgG24gaAEfRQCtVVvw38RIm96a+nFAk5DQ5sIR0dSeEf2y37+yGyN
47uN14hMOvyPXxliZy7E9T6rgSGnnH+72Tfx+yVLPthAsslxkBvtK6hNmZZfUPKB
dT193Nb8fYnw/CfgrjodYMcBj/I5vWlHN3CjXcHqEAaG9iyaDeHNP0mRAoGAC5dF
xZAGyySYbi0i9aE7xPC3e1gL28HjRPGJZkv75CwaHvEO+lJfill9OYQd4WuLvqHM
74Gf88ekF/5Fv8Ab2wQBUqP30CUv3A9gkZ29AxTHxhUmgntFVwV0BezISZGhEiEh
My6WDHblopoz/X3FGUfsDWJPTYbav6BBD7vxiBkCgYBaocPX4174YfmGKagOG4o1
eCoK5y+amr1grfIpBCsSs6p0k8rSVVPJqq5f5smnFUSdm0KnPzGM/qm/rwcyRIEj
fct/NtIABfuQvOoEGBa9NVtvKQVLjVLc9LrkutfxaOQ2CuwLfTbH/fKLYFgA48/y
tSAm7J4qGiK4u5h7RsN5LQ==
-----END PRIVATE KEY-----`;

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

const WEB_SERVICE_URL = process.env.WALLET_WEB_SERVICE_URL
  || 'https://alsdraft0-production.up.railway.app/api/loyalty';
const AUTH_TOKEN_SECRET = process.env.WALLET_AUTH_SECRET || PASS_TYPE_ID + TEAM_ID;

function isConfigured() {
  return !!(PASS_TYPE_ID && TEAM_ID && SIGNER_CERT_PEM && SIGNER_KEY_PEM);
}

function authTokenForSerial(serial: string): string {
  return crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(serial).digest('hex');
}

async function ensureTables() {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.from('wallet_pass_registrations').select('id').limit(1);
  if (!error) {
    console.log('[WalletPass] Registration tables OK');
    return;
  }
  console.log('[WalletPass] Tables missing, attempting auto-create...');
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.warn('[WalletPass] Set DATABASE_URL env var or create tables via Supabase SQL editor. See server/migrations/001_wallet_pass_tables.sql');
    return;
  }
  try {
    const { Client } = require('pg');
    const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_pass_registrations (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        device_library_id text NOT NULL,
        push_token text NOT NULL,
        pass_type_id text NOT NULL,
        serial_number text NOT NULL,
        created_at timestamptz DEFAULT now(),
        UNIQUE(device_library_id, pass_type_id, serial_number)
      );
      CREATE TABLE IF NOT EXISTS wallet_pass_updates (
        serial_number text PRIMARY KEY,
        last_updated bigint NOT NULL DEFAULT (extract(epoch from now())::bigint)
      );
      CREATE INDEX IF NOT EXISTS idx_wpr_serial ON wallet_pass_registrations(serial_number);
      CREATE INDEX IF NOT EXISTS idx_wpr_device ON wallet_pass_registrations(device_library_id, pass_type_id);
    `);
    await client.end();
    console.log('[WalletPass] Tables created via DATABASE_URL');
  } catch (e: any) {
    console.warn('[WalletPass] Auto-create failed:', e.message, '— create tables manually');
  }
}

ensureTables();

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

function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xEDB88320 : 0);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

function hexToRgbValues(hex: string): { r: number; g: number; b: number } {
  let h = (hex || '').replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6) return { r: 99, g: 102, b: 241 };
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

function createStripPng(w: number, h: number, r: number, g: number, b: number): Buffer {
  const lineH = 3;
  /** Subtle bottom accent — avoid a harsh band on the wallet strip. */
  const lr = Math.min(255, Math.round(r + (255 - r) * 0.14));
  const lg = Math.min(255, Math.round(g + (255 - g) * 0.14));
  const lb = Math.min(255, Math.round(b + (255 - b) * 0.14));

  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;
    const isLine = y >= h - lineH;
    const pr = isLine ? lr : r;
    const pg = isLine ? lg : g;
    const pb = isLine ? lb : b;
    for (let x = 0; x < w; x++) {
      const px = off + 1 + x * 3;
      raw[px] = pr;
      raw[px + 1] = pg;
      raw[px + 2] = pb;
    }
  }

  const compressed = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const ICON_1X = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAB0AAAAdCAIAAADZ8fBYAAAAJUlEQVR4nGNgmNJBEzRq7qi5o+aOmjtq7qi5o+aOmjtq7qAyFwCzp6UqMm3T+QAAAABJRU5ErkJggg==', 'base64');
const ICON_2X = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADoAAAA6CAIAAABu2d1/AAAAZUlEQVR4nO3OAQkAMAzAsMm/gAm+jHZQiIDM7LuEH9TV4Ad1NfhBXQ1+UFeDH9TV4Ad1NfhBXQ1+UFeDH9TV4Ad1NfhBXQ1+UFeDH9TV4Ad1NfhBXQ1+UFeDH9TV4Ad1NfhBXYsP2s6Uw9dI6msAAAAASUVORK5CYII=', 'base64');
const ICON_3X = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAFcAAABXCAIAAAD+qk47AAAA9ElEQVR4nO3OQQ0AIAADsclHAIKR0XuQVEC3e775QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfBDx2KM69DQL8FwAAAABJRU5ErkJggg==', 'base64');

function sha1Hex(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function getTier(lifetimePoints: number): string {
  if (lifetimePoints >= 2000) return 'Gold';
  if (lifetimePoints >= 1000) return 'Silver';
  return 'Bronze';
}

function formatExpiryDate(lastEarnDate: string | null, expiryMonths: number | null): string {
  if (!expiryMonths) return 'Never';
  const base = lastEarnDate ? new Date(lastEarnDate) : new Date();
  base.setMonth(base.getMonth() + expiryMonths);
  return base.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** Apple Wallet store-card logo max sizes (pt); @2x is doubled. */
const WALLET_LOGO_SLOT_1X = { w: 160, h: 50 };
const WALLET_LOGO_SLOT_2X = { w: 320, h: 100 };
const WALLET_LOGO_LEFT_BIAS = 0.05;

/**
 * Apple Wallet logo rendering:
 * - use the merchant-uploaded wallet logo only
 * - trim transparent edges first so the artwork stays crisp
 * - resize directly from the original buffer to avoid double-resize softness
 * - keep the result inside Apple's slot and bias it slightly left to match the older layout
 */
async function buildWalletLogoPngBuffers(
  logoUrl: string,
  scalePercent: number,
): Promise<{ logo1x: Buffer; logo2x: Buffer } | null> {
  let sharpMod: typeof import('sharp');
  try {
    sharpMod = (await import('sharp')).default;
  } catch {
    console.warn('[WalletPass] sharp not available; install sharp for scaled wallet logos');
    return null;
  }

  const res = await fetch(logoUrl);
  if (!res.ok) return null;
  const input = Buffer.from(await res.arrayBuffer());
  const scale = Math.min(200, Math.max(20, Math.round(scalePercent))) / 100;

  async function oneSlot(slotW: number, slotH: number): Promise<Buffer> {
    const trimmed = sharpMod(input).ensureAlpha().trim();
    const meta = await trimmed.metadata();
    const sourceW = meta.width ?? slotW;
    const sourceH = meta.height ?? slotH;
    const fitRatio = Math.min(slotW / sourceW, slotH / sourceH);
    const baseW = Math.max(1, sourceW * fitRatio);
    const baseH = Math.max(1, sourceH * fitRatio);
    const appliedScale = Math.min(scale, slotW / baseW, slotH / baseH);
    const targetW = Math.max(1, Math.round(baseW * appliedScale));
    const targetH = Math.max(1, Math.round(baseH * appliedScale));

    const scaled = await trimmed
      .resize(targetW, targetH, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        kernel: 'lanczos3',
        withoutEnlargement: false,
      })
      .png({ compressionLevel: 6, effort: 10 })
      .toBuffer();

    const remainingX = Math.max(0, slotW - targetW);
    const left = Math.max(0, Math.round((remainingX / 2) - (slotW * WALLET_LOGO_LEFT_BIAS)));
    const top = Math.max(0, Math.round((slotH - targetH) / 2));

    return sharpMod({
      create: {
        width: slotW,
        height: slotH,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: scaled, left, top }])
      .png()
      .toBuffer();
  }

  const [logo1x, logo2x] = await Promise.all([
    oneSlot(WALLET_LOGO_SLOT_1X.w, WALLET_LOGO_SLOT_1X.h),
    oneSlot(WALLET_LOGO_SLOT_2X.w, WALLET_LOGO_SLOT_2X.h),
  ]);

  return { logo1x, logo2x };
}

/** Wallet pass logo uses only the merchant-uploaded wallet icon. No fallback to in-app branding. */
function resolveWalletLogoUrl(
  walletCardLogoUrl: string | null | undefined,
): string | null {
  const w = typeof walletCardLogoUrl === 'string' ? walletCardLogoUrl.trim() : '';
  return w || null;
}

/**
 * Wallet pass logo scale: fixed 100% in-slot fit (merchant uploads artwork at intended size).
 * Per-product: wallet logo resize / “same as in-app” UI was removed from the dashboard.
 */
function resolveWalletLogoScale(
  _loyalty: { wallet_card_logo_scale?: unknown } | null | undefined,
  _appInAppScale: number,
): number {
  return 100;
}

/** Slightly dimmer than body text for field labels (Apple Wallet readability). */
function mutedLabelRgb(textColor: string): string {
  if (textColor.startsWith('rgb')) return mutedLabelFromForegroundRgb(textColor);
  const { r, g, b } = hexToRgbValues(textColor);
  const d = 0.82;
  return `rgb(${Math.round(r * d)}, ${Math.round(g * d)}, ${Math.round(b * d)})`;
}

/** When foreground is already an `rgb(...)` string (e.g. from config), dim it for labels. */
function mutedLabelFromForegroundRgb(fgRgb: string): string {
  const m = fgRgb.match(/\d+/g);
  if (!m || m.length < 3) return 'rgb(210, 210, 210)';
  const r = Number(m[0]);
  const g = Number(m[1]);
  const b = Number(m[2]);
  const d = 0.82;
  return `rgb(${Math.round(r * d)}, ${Math.round(g * d)}, ${Math.round(b * d)})`;
}

function resolveWalletCardBgColor(
  loyalty: { wallet_card_bg_color?: string | null } | null | undefined,
  appConfig: { primary_color?: string | null } | null | undefined,
): string {
  const loyaltyBg = typeof loyalty?.wallet_card_bg_color === 'string' ? loyalty.wallet_card_bg_color.trim() : '';
  if (loyaltyBg) return loyaltyBg;
  const brandBg = typeof appConfig?.primary_color === 'string' ? appConfig.primary_color.trim() : '';
  return brandBg || '#0D9488';
}

function resolveWalletLogoText(
  merchantName: string | null | undefined,
  appName: string | null | undefined,
  cardLabel: string,
): string {
  const merchant = typeof merchantName === 'string' ? merchantName.trim() : '';
  if (merchant) return merchant;
  const app = typeof appName === 'string' ? appName.trim() : '';
  return app || cardLabel;
}

async function attachWalletLogosToFiles(
  files: Record<string, Buffer>,
  opts: { logoUrl: string | null; inAppLogoScale: number },
): Promise<void> {
  const { logoUrl, inAppLogoScale } = opts;
  if (!logoUrl) return;

  const built = await buildWalletLogoPngBuffers(logoUrl, inAppLogoScale);
  if (built) {
    files['logo.png'] = built.logo1x;
    files['logo@2x.png'] = built.logo2x;
    return;
  }

  try {
    const logoRes = await fetch(logoUrl);
    if (logoRes.ok) {
      const logoBuf = Buffer.from(await logoRes.arrayBuffer());
      files['logo.png'] = logoBuf;
      files['logo@2x.png'] = logoBuf;
    }
  } catch {
    /* skip */
  }
}

function buildPassJson(opts: {
  serialNumber: string;
  description: string;
  organizationName: string;
  logoText: string;
  bgColor: string;
  fgColor: string;
  labelColor: string;
  cardLabel: string;
  points: number;
  lifetimePoints: number;
  pointValueSar: number;
  earnRate: string;
  tier: string;
  expiresLabel: string;
  barcodeMessage: string;
  customerId: string;
  hasLogoImage: boolean;
}): Buffer {
  const pass: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: PASS_TYPE_ID,
    teamIdentifier: TEAM_ID,
    serialNumber: opts.serialNumber,
    description: opts.description,
    organizationName: opts.organizationName,
    backgroundColor: opts.bgColor,
    foregroundColor: opts.fgColor,
    labelColor: opts.labelColor,
    logoText: opts.logoText,
    webServiceURL: WEB_SERVICE_URL,
    authenticationToken: authTokenForSerial(opts.serialNumber),
    barcodes: [
      {
        format: 'PKBarcodeFormatCode128',
        message: opts.barcodeMessage,
        messageEncoding: 'iso-8859-1',
        altText: opts.barcodeMessage,
      },
    ],
    storeCard: {
      headerFields: [
        { key: 'member', label: 'MEMBER', value: opts.tier },
      ],
      primaryFields: [
        { key: 'points', label: 'POINTS BALANCE', value: String(opts.points) },
      ],
      secondaryFields: [
        { key: 'worth', label: 'WORTH', value: `${(opts.points * opts.pointValueSar).toFixed(2)} SAR` },
        { key: 'earn', label: 'EARN RATE', value: opts.earnRate },
      ],
      auxiliaryFields: [
        { key: 'expires', label: 'EXPIRES', value: opts.expiresLabel },
        {
          key: 'program',
          label: 'PROGRAM',
          value: opts.cardLabel.length > 22 ? `${opts.cardLabel.slice(0, 21)}…` : opts.cardLabel,
        },
      ],
      backFields: [
        { key: 'lifetime', label: 'Lifetime Points', value: String(opts.lifetimePoints) },
      ],
    },
  };
  return Buffer.from(JSON.stringify(pass));
}

function signWithOpenSSL(manifestBuf: Buffer): Buffer {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkpass-'));
  try {
    const certPath = path.join(tmpDir, 'signerCert.pem');
    const keyPath = path.join(tmpDir, 'signerKey.pem');
    const wwdrPath = path.join(tmpDir, 'wwdr.pem');
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const sigPath = path.join(tmpDir, 'signature');

    fs.writeFileSync(certPath, SIGNER_CERT_PEM);
    fs.writeFileSync(keyPath, SIGNER_KEY_PEM);
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

// ─── Apple Wallet Web Service (v1) ───

function verifyAuthHeader(req: any, serialNumber: string): boolean {
  const header = req.headers['authorization'] || '';
  const token = header.replace(/^ApplePass\s+/i, '');
  return token === authTokenForSerial(serialNumber);
}

// POST /v1/devices/:deviceId/registrations/:passTypeId/:serialNumber
walletPassRouter.post(
  '/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber',
  async (req, res) => {
    try {
      const { deviceId, passTypeId, serialNumber } = req.params;
      if (!verifyAuthHeader(req, serialNumber)) return res.sendStatus(401);
      if (!supabaseAdmin) return res.sendStatus(500);

      const pushToken = req.body?.pushToken;
      if (!pushToken) return res.sendStatus(400);

      const { data: existing } = await supabaseAdmin
        .from('wallet_pass_registrations')
        .select('id')
        .eq('device_library_id', deviceId)
        .eq('pass_type_id', passTypeId)
        .eq('serial_number', serialNumber)
        .maybeSingle();

      if (existing) {
        await supabaseAdmin
          .from('wallet_pass_registrations')
          .update({ push_token: pushToken })
          .eq('id', existing.id);
        return res.sendStatus(200);
      }

      await supabaseAdmin.from('wallet_pass_registrations').insert({
        device_library_id: deviceId,
        push_token: pushToken,
        pass_type_id: passTypeId,
        serial_number: serialNumber,
      });

      await supabaseAdmin.from('wallet_pass_updates').upsert({
        serial_number: serialNumber,
        last_updated: Math.floor(Date.now() / 1000),
      }, { onConflict: 'serial_number' });

      console.log(`[WalletPass] Device ${deviceId.substring(0, 8)}… registered for ${serialNumber}`);
      return res.sendStatus(201);
    } catch (err: any) {
      console.error('[WalletPass] register error:', err?.message);
      return res.sendStatus(500);
    }
  },
);

// DELETE /v1/devices/:deviceId/registrations/:passTypeId/:serialNumber
walletPassRouter.delete(
  '/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber',
  async (req, res) => {
    try {
      const { deviceId, passTypeId, serialNumber } = req.params;
      if (!verifyAuthHeader(req, serialNumber)) return res.sendStatus(401);
      if (!supabaseAdmin) return res.sendStatus(500);

      await supabaseAdmin
        .from('wallet_pass_registrations')
        .delete()
        .eq('device_library_id', deviceId)
        .eq('pass_type_id', passTypeId)
        .eq('serial_number', serialNumber);

      console.log(`[WalletPass] Device ${deviceId.substring(0, 8)}… unregistered for ${serialNumber}`);
      return res.sendStatus(200);
    } catch (err: any) {
      console.error('[WalletPass] unregister error:', err?.message);
      return res.sendStatus(500);
    }
  },
);

// GET /v1/devices/:deviceId/registrations/:passTypeId?passesUpdatedSince=TAG
walletPassRouter.get(
  '/v1/devices/:deviceId/registrations/:passTypeId',
  async (req, res) => {
    try {
      const { deviceId, passTypeId } = req.params;
      if (!supabaseAdmin) return res.sendStatus(500);

      const { data: regs } = await supabaseAdmin
        .from('wallet_pass_registrations')
        .select('serial_number')
        .eq('device_library_id', deviceId)
        .eq('pass_type_id', passTypeId);

      if (!regs || regs.length === 0) return res.sendStatus(204);

      const serials = regs.map((r: any) => r.serial_number);
      const tag = req.query.passesUpdatedSince as string;

      let query = supabaseAdmin
        .from('wallet_pass_updates')
        .select('serial_number, last_updated')
        .in('serial_number', serials);

      if (tag) {
        query = query.gt('last_updated', Number(tag));
      }

      const { data: updated } = await query;
      if (!updated || updated.length === 0) return res.sendStatus(204);

      const maxTag = Math.max(...updated.map((u: any) => u.last_updated));
      return res.json({
        serialNumbers: updated.map((u: any) => u.serial_number),
        lastUpdated: String(maxTag),
      });
    } catch (err: any) {
      console.error('[WalletPass] serial list error:', err?.message);
      return res.sendStatus(500);
    }
  },
);

// GET /v1/passes/:passTypeId/:serialNumber
walletPassRouter.get(
  '/v1/passes/:passTypeId/:serialNumber',
  async (req, res) => {
    try {
      const { serialNumber } = req.params;
      if (!verifyAuthHeader(req, serialNumber)) return res.sendStatus(401);
      if (!isConfigured() || !supabaseAdmin) return res.sendStatus(500);

      const parts = serialNumber.match(/^loyalty-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/i);
      if (!parts) return res.sendStatus(404);
      const [, merchantId, customerId] = parts;

      const { data: pointsData } = await supabaseAdmin
        .from('loyalty_points').select('points, lifetime_points, updated_at')
        .eq('customer_id', customerId).eq('merchant_id', merchantId).single();
      const points = pointsData?.points ?? 0;
      const lifetimePoints = pointsData?.lifetime_points ?? 0;
      const lastEarnDate = pointsData?.updated_at ?? null;

      const [{ data: config }, { data: appConfig }, { data: merchant }] = await Promise.all([
        supabaseAdmin.from('loyalty_config').select('*').eq('merchant_id', merchantId).maybeSingle(),
        supabaseAdmin.from('app_config').select('app_name, in_app_logo_scale, primary_color').eq('merchant_id', merchantId).maybeSingle(),
        supabaseAdmin.from('merchants').select('cafe_name').eq('id', merchantId).maybeSingle(),
      ]);

      const bgColor = resolveWalletCardBgColor(config, appConfig);
      const textColor = config?.wallet_card_text_color || '#FFFFFF';
      const cardLabel = config?.wallet_card_label || 'Your Points';
      const pointValueSar = config?.point_value_sar ?? 0.1;
      const pointsPerSar = config?.points_per_sar ?? 0.1;
      const earnRate = config?.earn_mode === 'per_order'
        ? `${config?.points_per_order ?? 10} pts/order`
        : `${Math.round(pointsPerSar * 100)}% back`;

      const tier = getTier(lifetimePoints);
      const expiresLabel = formatExpiryDate(lastEarnDate, config?.expiry_months ?? null);
      const tierPrefix = tier.substring(0, 3).toUpperCase();
      const custSuffix = customerId.replace(/-/g, '').substring(0, 7).toUpperCase();
      const barcodeMessage = `MBR${tierPrefix}-${custSuffix}`;

      const { r: bgR, g: bgG, b: bgB } = hexToRgbValues(bgColor);
      const stripPng = createStripPng(750, 246, bgR, bgG, bgB);

      const files: Record<string, Buffer> = {
        'icon.png': ICON_1X,
        'icon@2x.png': ICON_2X,
        'icon@3x.png': ICON_3X,
        'strip.png': stripPng,
        'strip@2x.png': stripPng,
      };

      const logoUrl = resolveWalletLogoUrl(config?.wallet_card_logo_url);
      const logoText = resolveWalletLogoText(
        merchant?.cafe_name as string | undefined,
        appConfig?.app_name as string | undefined,
        cardLabel,
      );
      const inAppLogoScale = resolveWalletLogoScale(
        config,
        Number(appConfig?.in_app_logo_scale ?? 100) || 100,
      );
      await attachWalletLogosToFiles(files, { logoUrl, inAppLogoScale });

      files['pass.json'] = buildPassJson({
        serialNumber,
        description: cardLabel,
        organizationName: logoText,
        logoText,
        bgColor: hexToRgb(bgColor),
        fgColor: hexToRgb(textColor),
        labelColor: mutedLabelRgb(textColor),
        cardLabel,
        points,
        lifetimePoints,
        pointValueSar,
        earnRate,
        tier,
        expiresLabel,
        barcodeMessage,
        customerId,
        hasLogoImage: !!logoUrl,
      });

      const pkpass = await createPassBuffer(files);
      const modTag = req.headers['if-modified-since'];
      const { data: upd } = await supabaseAdmin
        .from('wallet_pass_updates')
        .select('last_updated')
        .eq('serial_number', serialNumber)
        .maybeSingle();
      const lastMod = new Date((upd?.last_updated ?? Math.floor(Date.now() / 1000)) * 1000).toUTCString();

      if (modTag && modTag === lastMod) return res.sendStatus(304);

      res.set({
        'Content-Type': 'application/vnd.apple.pkpass',
        'Content-Length': String(pkpass.length),
        'Last-Modified': lastMod,
      });
      return res.end(pkpass);
    } catch (err: any) {
      console.error('[WalletPass] updated pass error:', err?.message);
      return res.sendStatus(500);
    }
  },
);

// ─── APNs Push ───

async function sendApnsPush(pushToken: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const client = http2.connect('https://api.push.apple.com:443', {
        cert: SIGNER_CERT_PEM,
        key: SIGNER_KEY_PEM,
      });
      client.on('error', () => { client.close(); resolve(false); });

      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${pushToken}`,
        'apns-topic': PASS_TYPE_ID,
        'apns-push-type': 'background',
        'apns-priority': '5',
      });

      req.end(JSON.stringify({}));

      req.on('response', (headers) => {
        const status = headers[':status'];
        client.close();
        resolve(status === 200);
      });

      req.on('error', () => { client.close(); resolve(false); });
      setTimeout(() => { try { client.close(); } catch {} resolve(false); }, 10000);
    } catch {
      resolve(false);
    }
  });
}

export async function notifyPassUpdate(customerId: string, merchantId: string): Promise<void> {
  if (!supabaseAdmin || !isConfigured()) return;

  const serialNumber = `loyalty-${merchantId}-${customerId}`;
  const now = Math.floor(Date.now() / 1000);

  await supabaseAdmin.from('wallet_pass_updates').upsert({
    serial_number: serialNumber,
    last_updated: now,
  }, { onConflict: 'serial_number' });

  const { data: regs } = await supabaseAdmin
    .from('wallet_pass_registrations')
    .select('push_token')
    .eq('serial_number', serialNumber);

  if (!regs || regs.length === 0) return;

  const uniqueTokens = [...new Set(regs.map((r: any) => r.push_token))];
  for (const token of uniqueTokens) {
    const ok = await sendApnsPush(token);
    console.log(`[WalletPass] APNs push to ${token.substring(0, 8)}…: ${ok ? 'OK' : 'FAIL'}`);
  }
}

// ─── Routes ───

walletPassRouter.get('/wallet-pass/check', (_req, res) => {
  if (!isConfigured() || !supabaseAdmin) return res.status(501).json({ available: false });
  res.json({ available: true });
});

walletPassRouter.post('/wallet-pass/setup', async (_req, res) => {
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!dbUrl) return res.status(400).json({ error: 'Set DATABASE_URL env var first' });
  try {
    const { Client } = require('pg');
    const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_pass_registrations (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        device_library_id text NOT NULL,
        push_token text NOT NULL,
        pass_type_id text NOT NULL,
        serial_number text NOT NULL,
        created_at timestamptz DEFAULT now(),
        UNIQUE(device_library_id, pass_type_id, serial_number)
      );
      CREATE TABLE IF NOT EXISTS wallet_pass_updates (
        serial_number text PRIMARY KEY,
        last_updated bigint NOT NULL DEFAULT (extract(epoch from now())::bigint)
      );
      CREATE INDEX IF NOT EXISTS idx_wpr_serial ON wallet_pass_registrations(serial_number);
      CREATE INDEX IF NOT EXISTS idx_wpr_device ON wallet_pass_registrations(device_library_id, pass_type_id);
    `);
    await client.end();
    res.json({ success: true, message: 'Tables created' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

walletPassRouter.get('/wallet-pass/debug', async (_req, res) => {
  const info: Record<string, unknown> = {
    passTypeId: PASS_TYPE_ID,
    teamId: TEAM_ID,
    configured: isConfigured(),
    version: 'v19-auto-update',
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
    fs.writeFileSync(certPath, SIGNER_CERT_PEM);
    fs.writeFileSync(keyPath, SIGNER_KEY_PEM);
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
        logoText: 'Debug',
        bgColor: 'rgb(0,0,0)',
        fgColor: 'rgb(255,255,255)',
        labelColor: 'rgb(210, 210, 210)',
        cardLabel: 'Debug',
        points: 0, lifetimePoints: 0, pointValueSar: 0.1,
        earnRate: '10% back',
        tier: 'Bronze',
        expiresLabel: 'Never',
        barcodeMessage: 'MBRBRO-DEBUG00',
        customerId: 'debug',
        hasLogoImage: false,
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

    // Verify the pass cert chain: signerCert must be signed by WWDR G4
    try {
      const chainResult = execFileSync('openssl', [
        'verify', '-partial_chain', '-CAfile', wwdrPath, certPath,
      ], { timeout: 5000 }).toString();
      info.certChainVerification = chainResult.trim();
    } catch (e: any) {
      info.certChainVerification = 'FAIL - ' + (e.stderr?.toString() || e.message).substring(0, 300);
    }

    // Also get the signer cert fingerprint
    try {
      const fp = execFileSync('openssl', [
        'x509', '-in', certPath, '-noout', '-fingerprint', '-sha256',
      ], { timeout: 5000 }).toString();
      info.signerCertFingerprint = fp.trim();
    } catch { /* ignore */ }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(vDir, { recursive: true, force: true });
  } catch (e: any) {
    info.error = e.message;
    info.stderr = e.stderr?.toString()?.substring(0, 300);
  }

  res.json(info);
});

walletPassRouter.get('/wallet-pass/test', async (req, res) => {
  try {
    if (!isConfigured()) return res.status(501).json({ error: 'Not configured' });

    let bgHex = '#0D9488';
    let textColor = 'rgb(255, 255, 255)';
    let cardLabel = 'Loyalty Card';
    let earnRate = '10% back in points';
    let logoUrl: string | null = null;

    const merchantId = req.query.merchantId as string;
    let inAppLogoScale = 100;
    let logoText = cardLabel;
    if (merchantId && supabaseAdmin) {
      const [{ data: config }, { data: appConfig }, { data: merchant }] = await Promise.all([
        supabaseAdmin.from('loyalty_config').select('*').eq('merchant_id', merchantId).maybeSingle(),
        supabaseAdmin.from('app_config').select('app_name, in_app_logo_scale, primary_color').eq('merchant_id', merchantId).maybeSingle(),
        supabaseAdmin.from('merchants').select('cafe_name').eq('id', merchantId).maybeSingle(),
      ]);
      if (config) {
        bgHex = resolveWalletCardBgColor(config, appConfig);
        textColor = hexToRgb(config.wallet_card_text_color || '#FFFFFF');
        cardLabel = config.wallet_card_label || 'Loyalty Card';
        const pps = config.points_per_sar ?? 0.1;
        earnRate = config.earn_mode === 'per_order'
          ? `${config.points_per_order ?? 10} points per order`
          : `${Math.round(pps * 100)}% back in points`;
      }
      logoUrl = resolveWalletLogoUrl(config?.wallet_card_logo_url);
      logoText = resolveWalletLogoText(
        merchant?.cafe_name as string | undefined,
        appConfig?.app_name as string | undefined,
        cardLabel,
      );
      inAppLogoScale = resolveWalletLogoScale(
        config,
        Number(appConfig?.in_app_logo_scale ?? 100) || 100,
      );
    }

    const { r: bgR, g: bgG, b: bgB } = hexToRgbValues(bgHex);
    const testStrip = createStripPng(750, 246, bgR, bgG, bgB);
    const files: Record<string, Buffer> = {
      'icon.png': ICON_1X,
      'icon@2x.png': ICON_2X,
      'icon@3x.png': ICON_3X,
      'strip.png': testStrip,
      'strip@2x.png': testStrip,
    };

    if (logoUrl) {
      await attachWalletLogosToFiles(files, { logoUrl, inAppLogoScale });
    }

    files['pass.json'] = buildPassJson({
      serialNumber: `test-${Date.now()}`,
      description: cardLabel,
      organizationName: logoText,
      logoText,
      bgColor: hexToRgb(bgHex),
      fgColor: textColor,
      labelColor: mutedLabelFromForegroundRgb(textColor),
      cardLabel,
      points: 0,
      lifetimePoints: 0,
      pointValueSar: 0.1,
      earnRate,
      tier: 'Bronze',
      expiresLabel: 'Never',
      barcodeMessage: 'MBRBRO-TEST000',
      customerId: 'test-customer',
      hasLogoImage: !!logoUrl,
    });

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
      .from('loyalty_points').select('points, lifetime_points, updated_at')
      .eq('customer_id', customerId).eq('merchant_id', merchantId).single();
    const points = pointsData?.points ?? 0;
    const lifetimePoints = pointsData?.lifetime_points ?? 0;
    const lastEarnDate = pointsData?.updated_at ?? null;

    const [{ data: config }, { data: appConfig }, { data: merchant }] = await Promise.all([
      supabaseAdmin.from('loyalty_config').select('*').eq('merchant_id', merchantId).maybeSingle(),
      supabaseAdmin.from('app_config').select('app_name, in_app_logo_scale, primary_color').eq('merchant_id', merchantId).maybeSingle(),
      supabaseAdmin.from('merchants').select('cafe_name').eq('id', merchantId).maybeSingle(),
    ]);

    const bgColor = resolveWalletCardBgColor(config, appConfig);
    const textColor = config?.wallet_card_text_color || '#FFFFFF';
    const cardLabel = config?.wallet_card_label || 'Your Points';
    const pointValueSar = config?.point_value_sar ?? 0.1;
    const pointsPerSar = config?.points_per_sar ?? 0.1;

    const earnRate = config?.earn_mode === 'per_order'
      ? `${config?.points_per_order ?? 10} pts/order`
      : `${Math.round(pointsPerSar * 100)}% back`;

    const tier = getTier(lifetimePoints);
    const expiresLabel = formatExpiryDate(lastEarnDate, config?.expiry_months ?? null);
    const tierPrefix = tier.substring(0, 3).toUpperCase();
    const custSuffix = customerId.replace(/-/g, '').substring(0, 7).toUpperCase();
    const barcodeMessage = `MBR${tierPrefix}-${custSuffix}`;

    const bgRgb = hexToRgb(bgColor);
    const { r: bgR, g: bgG, b: bgB } = hexToRgbValues(bgColor);
    const stripPng = createStripPng(750, 246, bgR, bgG, bgB);

    const files: Record<string, Buffer> = {
      'icon.png': ICON_1X,
      'icon@2x.png': ICON_2X,
      'icon@3x.png': ICON_3X,
      'strip.png': stripPng,
      'strip@2x.png': stripPng,
    };

    const logoUrl = resolveWalletLogoUrl(config?.wallet_card_logo_url);
    const logoText = resolveWalletLogoText(
      merchant?.cafe_name as string | undefined,
      appConfig?.app_name as string | undefined,
      cardLabel,
    );
    const inAppLogoScale = resolveWalletLogoScale(
      config,
      Number(appConfig?.in_app_logo_scale ?? 100) || 100,
    );
    await attachWalletLogosToFiles(files, { logoUrl, inAppLogoScale });

    files['pass.json'] = buildPassJson({
      serialNumber: `loyalty-${merchantId}-${customerId}`,
      description: cardLabel,
      organizationName: logoText,
      logoText,
      bgColor: bgRgb,
      fgColor: hexToRgb(textColor),
      labelColor: mutedLabelRgb(textColor),
      cardLabel,
      points,
      lifetimePoints,
      pointValueSar,
      earnRate,
      tier,
      expiresLabel,
      barcodeMessage,
      customerId,
      hasLogoImage: !!logoUrl,
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
