/**
 * Apple Wallet Pass generation + web service for live updates.
 * Signing via openssl, ZIP via yazl, push via HTTP/2 APNs.
 */
import { createClient } from '@supabase/supabase-js';
import { Router, type Request, type Response } from 'express';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http2 from 'http2';
import * as os from 'os';
import * as path from 'path';
import yazl from 'yazl';
import * as zlib from 'zlib';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';
import { ensureLoyaltyMemberProfile } from '../services/loyaltyMembers';
import { requireDiagnosticAccess } from '../utils/nooksInternal';
import { getCustomerLoyaltyRoute } from './loyalty';

export const walletPassRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const PASS_TYPE_ID = process.env.APPLE_PASS_TYPE_ID || '';
const TEAM_ID = process.env.APPLE_PASS_TEAM_ID || '';

function normalizePem(raw: string): string {
  return raw.replace(/\\n/g, '\n').trim();
}

function loadPem(rawEnvName: string, base64EnvName: string): string {
  const raw = (process.env[rawEnvName] || '').trim();
  if (raw) return normalizePem(raw);

  const encoded = (process.env[base64EnvName] || '').trim();
  if (!encoded) return '';

  return normalizePem(Buffer.from(encoded, 'base64').toString('utf8'));
}

const SIGNER_CERT_PEM = loadPem('APPLE_PASS_CERT_PEM', 'APPLE_PASS_CERT_BASE64');
const SIGNER_KEY_PEM = loadPem('APPLE_PASS_KEY_PEM', 'APPLE_PASS_KEY_BASE64');

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
const AUTH_TOKEN_SECRET = (process.env.WALLET_AUTH_SECRET || process.env.NOOKS_INTERNAL_SECRET || '').trim();

function isConfigured() {
  return !!(PASS_TYPE_ID && TEAM_ID && SIGNER_CERT_PEM && SIGNER_KEY_PEM && AUTH_TOKEN_SECRET);
}

function authTokenForSerial(serial: string): string {
  return crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(serial).digest('hex');
}

async function requireWalletPassCustomer(req: Request, res: Response, customerId: string) {
  const user = await requireAuthenticatedAppUser(req, res);
  if (!user) return null;
  if (user.id !== customerId) {
    res.status(403).json({ error: 'Forbidden - wallet pass does not belong to authenticated user' });
    return null;
  }
  return user;
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

/**
 * Render the stamp-card grid as the wallet pass strip image so the pass
 * mirrors the dashboard's loyalty preview 1:1 within Apple's storeCard
 * template. Each box reflects the customer's progress (filled vs empty)
 * and uses the merchant's configured colors and stamp icon.
 *
 * Returns null if `sharp` is unavailable or rendering fails so the caller
 * can fall back to the solid background strip.
 */
async function buildStampGridStripPng(opts: {
  stamps: number;
  stampTarget: number;
  bgColor: string;
  stampBoxColor: string;
  stampIconColor: string;
  stampIconUrl?: string | null;
  businessType: 'cafe' | 'restaurant';
}): Promise<Buffer | null> {
  let sharpMod: typeof import('sharp');
  try {
    sharpMod = (await import('sharp')).default;
  } catch {
    return null;
  }

  const W = 750;
  // Strip contains ONLY the stamp grid. Milestones come back via
  // pass.json secondaryFields/auxiliaryFields so Apple Wallet renders
  // them with its own RTL-capable Arabic text engine — SVG text via
  // sharp has no Arabic font and produced tofu boxes.
  const H = 300;
  const total = Math.max(1, Math.min(20, Math.round(opts.stampTarget) || 8));
  const filled = Math.max(0, Math.min(total, Math.round(opts.stamps) || 0));
  // Match the dashboard StampCardPreview grid: 1 row when 5 or fewer, otherwise 2 rows.
  const cols = total <= 5 ? total : Math.ceil(total / 2);
  const rows = Math.ceil(total / cols);

  // Boxes fill the full strip width end-to-end (padding=4 on each side,
  // gap=8 between cells). Boxes are allowed to be rectangular —
  // forcing squares caps us at box_height and leaves large side
  // margins. Typical result for 8 stamps at 4×2: 179×142 boxes.
  const padding = 4;
  const gap = 8;
  const boxW = Math.max(40, Math.floor((W - padding * 2 - gap * (cols - 1)) / cols));
  const boxH = Math.max(40, Math.floor((H - padding * 2 - gap * (rows - 1)) / rows));

  const gridW = cols * boxW + (cols - 1) * gap;
  const gridH = rows * boxH + (rows - 1) * gap;
  const startX = Math.round((W - gridW) / 2);
  const startY = Math.round((H - gridH) / 2);
  // Corner radius scales off the shorter box dimension so rectangular
  // boxes don't look like pills.
  const radius = Math.max(2, Math.round(Math.min(boxW, boxH) * 0.18));

  function toRgba(hex: string, alpha: number): string {
    let h = (hex || '').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return `rgba(16,185,129,${alpha})`;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // Optionally embed the merchant's uploaded stamp icon as an inline data URI.
  // libvips/librsvg supports <image href="data:..."> which keeps everything in
  // a single SVG and avoids a second sharp.composite pass.
  let customDataUrl: string | null = null;
  if (opts.stampIconUrl) {
    try {
      const r = await fetch(opts.stampIconUrl);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        const ct = r.headers.get('content-type') || 'image/png';
        customDataUrl = `data:${ct};base64,${buf.toString('base64')}`;
      }
    } catch {
      /* fall through with default icons */
    }
  }

  // Default outline icons (24x24 viewBox) used when the merchant hasn't
  // uploaded a custom stamp image. Two variants — coffee cup and fork+knife
  // — to match the dashboard's businessType-driven default.
  const defaultPath: Record<string, string> = {
    cafe: 'M5 11h12v3a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-3z M17 11h2.5a2.5 2.5 0 0 1 0 5H17 M8 4v3 M12 4v3 M16 4v3',
    restaurant: 'M6 3v8c0 1.1 0.9 2 2 2v8 M6 11h4 M10 3v8c0 1.1-0.9 2-2 2 M16 3c-1.1 0-2 0.9-2 2v6c0 1.1 0.9 2 2 2v8',
  };
  const iconPath = defaultPath[opts.businessType] || defaultPath.cafe;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${opts.bgColor}"/>`);

  for (let i = 0; i < total; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = startX + col * (boxW + gap);
    const y = startY + row * (boxH + gap);
    const isFilled = i < filled;
    const boxFill = isFilled ? toRgba(opts.stampBoxColor, 1) : toRgba(opts.stampBoxColor, 0.22);

    parts.push(`<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="${radius}" fill="${boxFill}"/>`);

    // Icon size is keyed off the SHORTER box dimension so the logo stays
    // comfortably inside rectangular cells. Merchants with an uploaded
    // stamp logo now fill 72% of that dimension; built-in glyphs 66%.
    const iconSize = Math.round(Math.min(boxW, boxH) * (customDataUrl ? 0.72 : 0.66));
    const iconX = x + Math.round((boxW - iconSize) / 2);
    const iconY = y + Math.round((boxH - iconSize) / 2);
    const iconOpacity = isFilled ? 1 : 0.35;

    if (customDataUrl) {
      parts.push(
        `<image href="${customDataUrl}" xlink:href="${customDataUrl}" x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" opacity="${iconOpacity}" preserveAspectRatio="xMidYMid meet"/>`,
      );
    } else {
      const scale = iconSize / 24;
      parts.push(
        `<g transform="translate(${iconX} ${iconY}) scale(${scale})" opacity="${iconOpacity}"><path d="${iconPath}" fill="none" stroke="${opts.stampIconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`,
      );
    }
  }

  parts.push('</svg>');

  try {
    return await sharpMod(Buffer.from(parts.join(''))).png({ compressionLevel: 6 }).toBuffer();
  } catch (err: any) {
    console.warn('[WalletPass] stamp grid render failed:', err?.message);
    return null;
  }
}


const ICON_1X = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAB0AAAAdCAIAAADZ8fBYAAAAJUlEQVR4nGNgmNJBEzRq7qi5o+aOmjtq7qi5o+aOmjtq7qAyFwCzp6UqMm3T+QAAAABJRU5ErkJggg==', 'base64');
const ICON_2X = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADoAAAA6CAIAAABu2d1/AAAAZUlEQVR4nO3OAQkAMAzAsMm/gAm+jHZQiIDM7LuEH9TV4Ad1NfhBXQ1+UFeDH9TV4Ad1NfhBXQ1+UFeDH9TV4Ad1NfhBXQ1+UFeDH9TV4Ad1NfhBXQ1+UFeDH9TV4Ad1NfhBXYsP2s6Uw9dI6msAAAAASUVORK5CYII=', 'base64');
const ICON_3X = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAFcAAABXCAIAAAD+qk47AAAA9ElEQVR4nO3OQQ0AIAADsclHAIKR0XuQVEC3e775QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfFPhBgR8U+EGBHxT4QYEfBDx2KM69DQL8FwAAAABJRU5ErkJggg==', 'base64');

function sha1Hex(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function formatExpiryDate(_lastEarnDate: string | null, expiryMonths: number | null): string {
  if (!expiryMonths) return 'Never';
  return `${Math.max(1, Math.round(expiryMonths))} mo`;
}

/** Apple Wallet store-card logo max sizes (pt); @2x is doubled. */
const WALLET_LOGO_SLOT_1X = { w: 160, h: 50 };
const WALLET_LOGO_SLOT_2X = { w: 320, h: 100 };
const WALLET_LOGO_SLOT_3X = { w: 480, h: 150 };
/**
 * Fraction of the Apple-allocated logo slot that the artwork is allowed
 * to fill. 60%×70% was too conservative — the logo looked tiny next to
 * the pass title on real devices. Raising to 90%×95% lets the artwork
 * breathe without overflowing Apple's reserved 160×50pt region.
 */
const WALLET_LOGO_ARTWORK_HEIGHT_RATIO = 0.9;
const WALLET_LOGO_ARTWORK_WIDTH_RATIO = 0.95;

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
): Promise<{ logo1x: Buffer; logo2x: Buffer; logo3x: Buffer } | null> {
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
    // Constrain the artwork to a fraction of the full slot so it visually
    // matches the in-app header logo rather than sprawling across Apple's
    // max 160×50pt slot.
    const artworkMaxW = slotW * WALLET_LOGO_ARTWORK_WIDTH_RATIO;
    const artworkMaxH = slotH * WALLET_LOGO_ARTWORK_HEIGHT_RATIO;
    const fitRatio = Math.min(artworkMaxW / sourceW, artworkMaxH / sourceH);
    const baseW = Math.max(1, sourceW * fitRatio);
    const baseH = Math.max(1, sourceH * fitRatio);
    const appliedScale = Math.min(scale, artworkMaxW / baseW, artworkMaxH / baseH);
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

    // Top-left anchor: the logo sits flush with the upper-left of Apple's
    // slot, with transparent padding filling the rest. This mirrors where
    // the in-app header places the logo.
    const left = 0;
    const top = 0;

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

  const [logo1x, logo2x, logo3x] = await Promise.all([
    oneSlot(WALLET_LOGO_SLOT_1X.w, WALLET_LOGO_SLOT_1X.h),
    oneSlot(WALLET_LOGO_SLOT_2X.w, WALLET_LOGO_SLOT_2X.h),
    oneSlot(WALLET_LOGO_SLOT_3X.w, WALLET_LOGO_SLOT_3X.h),
  ]);

  return { logo1x, logo2x, logo3x };
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

/**
 * The wallet pass logo text shown in the header mirrors the Loyalty dashboard's
 * Card Title (wallet_card_label). The dashboard preview renders that field in
 * the top-left of the card, so the pass should use the same source of truth.
 * Fallbacks (merchant name, app name) kick in only if the merchant leaves the
 * Card Title blank.
 */
function resolveWalletLogoText(
  merchantName: string | null | undefined,
  appName: string | null | undefined,
  cardLabel: string,
): string {
  const label = typeof cardLabel === 'string' ? cardLabel.trim() : '';
  if (label) return label;
  const merchant = typeof merchantName === 'string' ? merchantName.trim() : '';
  if (merchant) return merchant;
  const app = typeof appName === 'string' ? appName.trim() : '';
  if (app) return app;
  return 'Loyalty Card';
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
    files['logo@3x.png'] = built.logo3x;
    return;
  }

  try {
    const logoRes = await fetch(logoUrl);
    if (logoRes.ok) {
      const logoBuf = Buffer.from(await logoRes.arrayBuffer());
      files['logo.png'] = logoBuf;
      files['logo@2x.png'] = logoBuf;
      files['logo@3x.png'] = logoBuf;
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
  expiresLabel: string;
  barcodeMessage: string;
  memberCode: string;
  customerId: string;
  hasLogoImage: boolean;
  templateType?: string;
  stamps?: number;
  stampTarget?: number;
  stampEnabled?: boolean;
  nextRewardName?: string;
  nextRewardCost?: number;
  locations?: Array<{ lat: number; lng: number; name: string }>;
  loyaltyType?: string;
  cashbackBalance?: number;
  cashbackPercent?: number;
  businessType?: string;
  /**
   * All active stamp milestones for the merchant, sorted by stamp_number asc.
   * The first 2 render as secondary fields, next 2 as auxiliary fields; any
   * overflow lands in backFields.
   */
  milestones?: Array<{ stamp_number: number; reward_name: string }>;
}): Buffer {
  const loyaltyType = opts.loyaltyType ?? 'stamps';

  let storeCard: Record<string, unknown[]>;

  // Card Title sits on the top-right of the pass via a single right-aligned
  // header field. Pairs with `logoText: ''` at the pass top level so the
  // merchant logo sits alone on the top-left.
  const titleHeader = [
    {
      key: 'cardTitle',
      label: '',
      value: (opts.cardLabel || '').trim() || 'Loyalty Card',
      textAlignment: 'PKTextAlignmentRight',
    },
  ];

  switch (loyaltyType) {
    case 'cashback':
      storeCard = {
        headerFields: titleHeader,
        primaryFields: [
          { key: 'balance', label: 'CASHBACK BALANCE', value: `${(opts.cashbackBalance ?? 0).toFixed(2)} SAR` },
        ],
        secondaryFields: [
          { key: 'cashbackRate', label: 'CASHBACK RATE', value: `${opts.cashbackPercent ?? 5}% back` },
          { key: 'expires', label: 'EXPIRES', value: opts.expiresLabel, textAlignment: 'PKTextAlignmentRight' },
        ],
        backFields: [
          { key: 'memberCode', label: 'Member Code', value: opts.memberCode },
          { key: 'branchUse', label: 'In-store use', value: 'Show this barcode at the branch to earn cashback on your purchase.' },
          { key: 'redeem', label: 'Redeem', value: 'Cashback can be used at checkout in the app.' },
        ],
      };
      break;

    case 'stamps': {
      const filledCount = Math.min(opts.stamps ?? 0, opts.stampTarget ?? 8);
      const total = opts.stampTarget ?? 8;

      // Map the merchant's configured milestones onto Apple's field slots.
      // Layout goal (identical to the dashboard preview and the in-app card):
      //   header    → Card Title on the right, logo on the left
      //   strip     → rendered stamp grid (accurate per-customer fill)
      //   primary   → empty (the strip is the focal point)
      //   secondary → 1st + 2nd milestone (top row of the 2x2)
      //   auxiliary → 3rd + 4th milestone (bottom row of the 2x2)
      // The storeCard template can only fit 4 milestones on the pass front.
      // The Loyalty dashboard enforces that same cap when the merchant adds
      // milestones, so we slice here only defensively — in case older rows
      // still exist in the DB.
      const sortedMilestones = (opts.milestones ?? [])
        .filter((m) => m && typeof m.stamp_number === 'number' && (m.reward_name || '').trim().length > 0)
        .slice()
        .sort((a, b) => a.stamp_number - b.stamp_number)
        .slice(0, 4);

      const buildMilestoneField = (
        m: { stamp_number: number; reward_name: string },
        alignRight: boolean,
      ) => {
        const field: Record<string, unknown> = {
          key: `milestone_${m.stamp_number}`,
          label: `STAMP ${m.stamp_number}`,
          value: (m.reward_name || '').trim() || '—',
        };
        if (alignRight) field.textAlignment = 'PKTextAlignmentRight';
        return field;
      };

      const secondaryMilestones = sortedMilestones.slice(0, 2);
      const auxiliaryMilestones = sortedMilestones.slice(2, 4);

      const secondaryFields = secondaryMilestones.map((m, i) =>
        buildMilestoneField(m, i === secondaryMilestones.length - 1 && secondaryMilestones.length > 1),
      );
      const auxiliaryFields = auxiliaryMilestones.map((m, i) =>
        buildMilestoneField(m, i === auxiliaryMilestones.length - 1 && auxiliaryMilestones.length > 1),
      );

      storeCard = {
        headerFields: titleHeader,
        primaryFields: [],
        secondaryFields,
        auxiliaryFields,
        backFields: [
          { key: 'memberCode', label: 'Member Code', value: opts.memberCode },
          { key: 'stampsSummary', label: 'Stamps', value: `${filledCount} / ${total}` },
          { key: 'branchUse', label: 'In-store use', value: 'Show this barcode at the branch to earn stamps and redeem rewards.' },
          { key: 'howItWorks', label: 'How it works', value: 'Earn 1 stamp per completed order. Reach milestones to unlock rewards!' },
        ],
      };
      break;
    }

    default: // points
      storeCard = {
        headerFields: titleHeader,
        primaryFields: [
          { key: 'balance', label: 'POINTS BALANCE', value: opts.points },
        ],
        secondaryFields: [
          { key: 'worth', label: 'WORTH', value: `${(opts.points * opts.pointValueSar).toFixed(2)} SAR` },
          { key: 'earnRate', label: 'EARN RATE', value: opts.earnRate },
          { key: 'expires', label: 'EXPIRES', value: opts.expiresLabel },
        ],
        backFields: [
          { key: 'memberCode', label: 'Member Code', value: opts.memberCode },
          { key: 'lifetime', label: 'Lifetime Points', value: String(opts.lifetimePoints) },
          { key: 'branchUse', label: 'In-store use', value: 'Show this barcode at the branch to earn points.' },
          { key: 'redeem', label: 'Redeem', value: 'Points can be used at checkout in the app.' },
        ],
      };
      break;
  }

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
    // Card Title is rendered as a right-aligned headerField so the logo sits
    // alone on the top-left. Keeping logoText would duplicate the title.
    logoText: '',
    webServiceURL: WEB_SERVICE_URL,
    authenticationToken: authTokenForSerial(opts.serialNumber),
    barcodes: [
      {
        format: 'PKBarcodeFormatQR',
        message: opts.barcodeMessage,
        messageEncoding: 'iso-8859-1',
        altText: opts.memberCode,
      },
    ],
    storeCard,
  };

  // GPS geofence: show pass on lock screen near merchant branches
  if (opts.locations?.length) {
    pass.locations = opts.locations.map(loc => ({
      latitude: loc.lat,
      longitude: loc.lng,
      relevantText: `You're near ${loc.name}! Check your loyalty balance.`,
    }));
  }

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

      // Flag the customer as having deleted their pass — enables loyalty type switch on re-add
      const serialParts = serialNumber.match(/^loyalty-(.+)-([0-9a-f-]+)$/);
      if (serialParts && supabaseAdmin) {
        const [, sMerchantId, sCustomerId] = serialParts;
        await supabaseAdmin.from('loyalty_member_profiles')
          .update({ pass_deleted: true, pass_deleted_at: new Date().toISOString() })
          .eq('customer_id', sCustomerId).eq('merchant_id', sMerchantId);
        console.log(`[WalletPass] Flagged pass_deleted for customer ${sCustomerId.substring(0, 8)}…`);
      }

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
      const cardLabel = config?.wallet_card_label || merchant?.cafe_name || appConfig?.app_name || 'Loyalty Card';
      const passDescription = merchant?.cafe_name || config?.wallet_card_label || appConfig?.app_name || 'Loyalty Card';
      const pointValueSar = config?.point_value_sar ?? 0.1;
      const pointsPerSar = config?.points_per_sar ?? 0.1;
      const earnRate = config?.earn_mode === 'per_order'
        ? `${config?.points_per_order ?? 10} pts/order`
        : `${Math.round(pointsPerSar * 100)}% back`;

      const expiresLabel = formatExpiryDate(lastEarnDate, config?.expiry_months ?? null);
      const memberProfile = await ensureLoyaltyMemberProfile(merchantId, customerId);

      // Foodics Loyalty Adapter QR format: compact JSON with mobile number + country code
      // See: https://developers.foodics.com/guides/loyalty.html#qr-code-content
      const customerPhone = (memberProfile.phone_number || '').replace(/^\+?966/, '').replace(/^0/, '').trim();
      const barcodeMessage = customerPhone
        ? JSON.stringify({
            customer_name: memberProfile.display_name || 'Customer',
            customer_mobile_number: customerPhone,
            mobile_country_code: 966,
          })
        : memberProfile.member_code; // Fallback if no phone number

      const { r: bgR, g: bgG, b: bgB } = hexToRgbValues(bgColor);
      const solidStripPng = createStripPng(750, 246, bgR, bgG, bgB);

      const files: Record<string, Buffer> = {
        'icon.png': ICON_1X,
        'icon@2x.png': ICON_2X,
        'icon@3x.png': ICON_3X,
        'strip.png': solidStripPng,
        'strip@2x.png': solidStripPng,
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

      // Fetch stamp data, next reward, cashback balance, and branch locations
      // Effective type for the customer — same auto-migration contract as
      // the /api/loyalty/balance endpoint (keep old type until balance hits 0,
      // then migrate to the merchant's current config type).
      const route = await getCustomerLoyaltyRoute(merchantId, customerId);
      const loyaltyType = (route.redeem as 'cashback' | 'stamps' | null)
        || config?.loyalty_type
        || 'stamps';
      const [{ data: stampRow }, { data: cheapestReward }, { data: branches }, { data: cbRow }, { data: milestoneRows }] = await Promise.all([
        supabaseAdmin.from('loyalty_stamps').select('stamps, completed_cards')
          .eq('customer_id', customerId).eq('merchant_id', merchantId).maybeSingle(),
        supabaseAdmin.from('loyalty_rewards').select('name, points_cost')
          .eq('merchant_id', merchantId).eq('is_active', true)
          .order('points_cost', { ascending: true }).limit(1).maybeSingle(),
        supabaseAdmin.from('branch_mappings').select('name, latitude, longitude')
          .eq('merchant_id', merchantId)
          .not('latitude', 'is', null).not('longitude', 'is', null).limit(10),
        supabaseAdmin.from('loyalty_cashback_balances').select('balance_sar')
          .eq('customer_id', customerId).eq('merchant_id', merchantId)
          .order('config_version', { ascending: false }).limit(1).maybeSingle(),
        supabaseAdmin.from('loyalty_stamp_milestones').select('reward_name, stamp_number')
          .eq('merchant_id', merchantId).eq('is_active', true)
          .order('stamp_number', { ascending: true }),
      ]);
      const activeMilestones = (milestoneRows ?? []) as Array<{ stamp_number: number; reward_name: string }>;
      const currentStampsForNext = stampRow?.stamps ?? 0;
      const nextMilestone = activeMilestones.find((m) => m.stamp_number > currentStampsForNext) ?? activeMilestones[0] ?? null;

      // Stamps loyalty: render the stamp grid as the strip image so the pass
      // mirrors the dashboard's preview (filled boxes match the customer's
      // current stamp count, colors and icon respect the merchant's config).
      if (loyaltyType === 'stamps') {
        const stampGrid = await buildStampGridStripPng({
          stamps: stampRow?.stamps ?? 0,
          stampTarget: config?.stamp_target ?? 8,
          bgColor,
          stampBoxColor: config?.wallet_stamp_box_color ?? '#10B981',
          stampIconColor: config?.wallet_stamp_icon_color ?? '#FFFFFF',
          stampIconUrl: config?.wallet_stamp_icon_url ?? null,
          businessType: (config?.business_type as 'cafe' | 'restaurant') ?? 'cafe',
        });
        if (stampGrid) {
          files['strip.png'] = stampGrid;
          files['strip@2x.png'] = stampGrid;
        }
      }

      files['pass.json'] = buildPassJson({
        serialNumber,
        description: passDescription,
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

        expiresLabel,
        barcodeMessage,
        memberCode: memberProfile.member_code,
        customerId,
        hasLogoImage: !!logoUrl,
        loyaltyType,
        cashbackBalance: cbRow?.balance_sar ?? 0,
        cashbackPercent: config?.cashback_percent ?? 5,
        businessType: config?.business_type ?? 'cafe',
        stamps: stampRow?.stamps ?? 0,
        stampTarget: config?.stamp_target ?? 8,
        stampEnabled: loyaltyType === 'stamps' || (config?.stamp_enabled ?? false),
        nextRewardName: nextMilestone?.reward_name ?? cheapestReward?.name ?? undefined,
        nextRewardCost: cheapestReward?.points_cost ?? undefined,
        milestones: activeMilestones,
        locations: (branches ?? [])
          .filter((b: any) => b.latitude && b.longitude)
          .map((b: any) => ({ lat: Number(b.latitude), lng: Number(b.longitude), name: b.name || 'Branch' })),
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

walletPassRouter.post('/wallet-pass/setup', async (req, res) => {
  if (!requireDiagnosticAccess(req, res)) return;
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

walletPassRouter.get('/wallet-pass/debug', async (req, res) => {
  if (!requireDiagnosticAccess(req, res)) return;
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
        expiresLabel: 'Never',
        barcodeMessage: 'NKDEBUG00',
        memberCode: 'NKDEBUG00',
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
    if (!requireDiagnosticAccess(req, res)) return;
    if (!isConfigured()) return res.status(501).json({ error: 'Not configured' });

    let bgHex = '#0D9488';
    let textColor = 'rgb(255, 255, 255)';
    let cardLabel = 'Loyalty Card';
    let passDescription = 'Loyalty Card';
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
        cardLabel = config.wallet_card_label || merchant?.cafe_name || appConfig?.app_name || 'Loyalty Card';
        passDescription = merchant?.cafe_name || config.wallet_card_label || appConfig?.app_name || 'Loyalty Card';
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
    const testStripBuffer: Buffer = createStripPng(750, 246, bgR, bgG, bgB);

    const files: Record<string, Buffer> = {
      'icon.png': ICON_1X,
      'icon@2x.png': ICON_2X,
      'icon@3x.png': ICON_3X,
      'strip.png': testStripBuffer,
      'strip@2x.png': testStripBuffer,
    };

    if (logoUrl) {
      await attachWalletLogosToFiles(files, { logoUrl, inAppLogoScale });
    }

    files['pass.json'] = buildPassJson({
      serialNumber: `test-${Date.now()}`,
      description: passDescription,
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
      expiresLabel: 'Never',
      barcodeMessage: 'NKTEST000',
      memberCode: 'NKTEST000',
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
    if (!await requireWalletPassCustomer(req, res, customerId)) return;
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
    const cardLabel = config?.wallet_card_label || merchant?.cafe_name || appConfig?.app_name || 'Loyalty Card';
    const passDescription = merchant?.cafe_name || config?.wallet_card_label || appConfig?.app_name || 'Loyalty Card';
    const pointValueSar = config?.point_value_sar ?? 0.1;
    const pointsPerSar = config?.points_per_sar ?? 0.1;

    const earnRate = config?.earn_mode === 'per_order'
      ? `${config?.points_per_order ?? 10} pts/order`
      : `${Math.round(pointsPerSar * 100)}% back`;

    const expiresLabel = formatExpiryDate(lastEarnDate, config?.expiry_months ?? null);
    const memberProfile = await ensureLoyaltyMemberProfile(merchantId, customerId);

    // Check if customer is re-adding a pass after deletion — this triggers loyalty type switch
    const { data: memberLoyaltyInfo } = await supabaseAdmin.from('loyalty_member_profiles')
      .select('active_loyalty_type, pass_deleted')
      .eq('customer_id', customerId).eq('merchant_id', merchantId)
      .maybeSingle();

    if (memberLoyaltyInfo?.pass_deleted) {
      const { data: currentConfig } = await supabaseAdmin.from('loyalty_config')
        .select('loyalty_type').eq('merchant_id', merchantId).maybeSingle();
      const newType = currentConfig?.loyalty_type;
      if (newType && newType !== memberLoyaltyInfo.active_loyalty_type) {
        // Customer is opting into the new loyalty type
        await supabaseAdmin.from('loyalty_member_profiles')
          .update({
            active_loyalty_type: newType,
            loyalty_type_opted_in_at: new Date().toISOString(),
            pass_deleted: false,
            pass_deleted_at: null,
          })
          .eq('customer_id', customerId).eq('merchant_id', merchantId);
        console.log(`[WalletPass] Customer ${customerId.substring(0, 8)}… switched loyalty type to ${newType}`);
      } else {
        // Same type or no type — just clear the deleted flag
        await supabaseAdmin.from('loyalty_member_profiles')
          .update({ pass_deleted: false, pass_deleted_at: null })
          .eq('customer_id', customerId).eq('merchant_id', merchantId);
      }
    }

    // Determine effective loyalty type: member override > config default
    // Ask the loyalty module for the customer's effective type. This handles
    // the transition contract (customer keeps old type until balance hits 0,
    // then auto-migrates to the merchant's current type) exactly the same way
    // the /api/loyalty/balance endpoint does.
    const route = await getCustomerLoyaltyRoute(merchantId, customerId);
    const loyaltyType = (route.redeem as 'cashback' | 'stamps' | null)
      || memberLoyaltyInfo?.active_loyalty_type
      || config?.loyalty_type
      || 'stamps';

    // Fetch type-specific balances and branch locations in parallel
    const [{ data: stampRow }, { data: cheapestReward }, { data: branches }, { data: cbRow }, { data: milestoneRows }] = await Promise.all([
      supabaseAdmin.from('loyalty_stamps').select('stamps, completed_cards')
        .eq('customer_id', customerId).eq('merchant_id', merchantId).maybeSingle(),
      supabaseAdmin.from('loyalty_rewards').select('name, points_cost')
        .eq('merchant_id', merchantId).eq('is_active', true)
        .order('points_cost', { ascending: true }).limit(1).maybeSingle(),
      supabaseAdmin.from('branch_mappings').select('name, latitude, longitude')
        .eq('merchant_id', merchantId)
        .not('latitude', 'is', null).not('longitude', 'is', null).limit(10),
      supabaseAdmin.from('loyalty_cashback_balances').select('balance_sar')
        .eq('customer_id', customerId).eq('merchant_id', merchantId)
        .order('config_version', { ascending: false }).limit(1).maybeSingle(),
      supabaseAdmin.from('loyalty_stamp_milestones').select('reward_name, stamp_number')
        .eq('merchant_id', merchantId).eq('is_active', true)
        .order('stamp_number', { ascending: true }),
    ]);
    const activeMilestones = (milestoneRows ?? []) as Array<{ stamp_number: number; reward_name: string }>;
    const currentStampsForNext = stampRow?.stamps ?? 0;
    const nextMilestone = activeMilestones.find((m) => m.stamp_number > currentStampsForNext) ?? activeMilestones[0] ?? null;

    // Foodics Loyalty Adapter QR format
    const customerPhone2 = (memberProfile.phone_number || '').replace(/^\+?966/, '').replace(/^0/, '').trim();
    const barcodeMessage = customerPhone2
      ? JSON.stringify({
          customer_name: memberProfile.display_name || 'Customer',
          customer_mobile_number: customerPhone2,
          mobile_country_code: 966,
        })
      : memberProfile.member_code;

    const bgRgb = hexToRgb(bgColor);
    const { r: bgR, g: bgG, b: bgB } = hexToRgbValues(bgColor);
    const solidStripPng = createStripPng(750, 246, bgR, bgG, bgB);
    const stripBuffer: Buffer = solidStripPng;

    const files: Record<string, Buffer> = {
      'icon.png': ICON_1X,
      'icon@2x.png': ICON_2X,
      'icon@3x.png': ICON_3X,
      'strip.png': stripBuffer,
      'strip@2x.png': stripBuffer,
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

    // Stamps loyalty: replace the solid strip with the rendered stamp grid so
    // the pass front mirrors the dashboard's stamp-card preview 1:1 (colors,
    // icons, filled-vs-empty layout).
    if (loyaltyType === 'stamps') {
      const stampGrid = await buildStampGridStripPng({
        stamps: stampRow?.stamps ?? 0,
        stampTarget: config?.stamp_target ?? 8,
        bgColor,
        stampBoxColor: config?.wallet_stamp_box_color ?? '#10B981',
        stampIconColor: config?.wallet_stamp_icon_color ?? '#FFFFFF',
        stampIconUrl: config?.wallet_stamp_icon_url ?? null,
        businessType: (config?.business_type as 'cafe' | 'restaurant') ?? 'cafe',
      });
      if (stampGrid) {
        files['strip.png'] = stampGrid;
        files['strip@2x.png'] = stampGrid;
      }
    }

    files['pass.json'] = buildPassJson({
      serialNumber: `loyalty-${merchantId}-${customerId}`,
      description: passDescription,
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
      expiresLabel,
      barcodeMessage,
      memberCode: memberProfile.member_code,
      customerId,
      hasLogoImage: !!logoUrl,
      loyaltyType,
      cashbackBalance: cbRow?.balance_sar ?? 0,
      cashbackPercent: config?.cashback_percent ?? 5,
      businessType: config?.business_type ?? 'cafe',
      stamps: stampRow?.stamps ?? 0,
      stampTarget: config?.stamp_target ?? 8,
      stampEnabled: loyaltyType === 'stamps' || (config?.stamp_enabled ?? false),
      nextRewardName: nextMilestone?.reward_name ?? cheapestReward?.name ?? undefined,
      nextRewardCost: cheapestReward?.points_cost ?? undefined,
      milestones: activeMilestones,
      locations: (branches ?? [])
        .filter((b: any) => b.latitude && b.longitude)
        .map((b: any) => ({ lat: Number(b.latitude), lng: Number(b.longitude), name: b.name || 'Branch' })),
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
