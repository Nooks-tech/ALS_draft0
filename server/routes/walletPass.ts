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
 * Render a horizontal progress bar for the points-mode strip image.
 *
 * Apple Wallet @1x/@2x dimensions for storeCard strips: 375×98 / 750×196,
 * but the spec for this renderer is a 300×60-equivalent visual treatment.
 * We render at 750×196 (Apple's @2x storeCard strip size) so the pass
 * looks crisp on Retina devices and keep the visual proportions of the
 * 300×60 brief — track + fill + centered "X pts to next reward" label.
 *
 * - Empty track: 22% alpha of textColor on a card-background-colored canvas
 * - Filled portion: full textColor
 * - Label: textColor (high contrast)
 *
 * Returns null if `sharp` is unavailable so the caller can fall back to
 * the solid background strip.
 */
async function buildPointsProgressStripPng(opts: {
  /** Current customer points (already rounded for display). */
  points: number;
  /** Threshold of the next unaffordable milestone (anchor for the bar). */
  nextThreshold: number | null;
  /** Bar background canvas (merchant's wallet_card_bg_color). */
  bgColor: string;
  /** Track + label color (merchant's wallet_card_text_color). */
  textColor: string;
  /** Override label — if null, a "X pts to next reward" string is rendered. */
  labelOverride?: string | null;
}): Promise<Buffer | null> {
  let sharpMod: typeof import('sharp');
  try {
    sharpMod = (await import('sharp')).default;
  } catch {
    return null;
  }

  // Apple storeCard strip @2x dimensions. 375x98 @1x scaled 2x for retina.
  const W = 750;
  const H = 196;

  function toRgba(color: string, alpha: number): string {
    // Accept #RRGGBB, #RGB, or rgb(...) — anything else falls back to white.
    const trimmed = (color || '').trim();
    if (trimmed.startsWith('rgb')) {
      const m = trimmed.match(/\d+/g);
      if (m && m.length >= 3) return `rgba(${m[0]},${m[1]},${m[2]},${alpha})`;
      return `rgba(255,255,255,${alpha})`;
    }
    let h = trimmed.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return `rgba(255,255,255,${alpha})`;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // Bar geometry — centered horizontally, slightly above vertical center
  // so the label has breathing room below.
  const barH = 36;
  const barX = 80;
  const barW = W - barX * 2;
  const barY = Math.round((H - barH) / 2) - 12;
  const radius = barH / 2;

  let progressRatio = 0;
  if (opts.nextThreshold && opts.nextThreshold > 0) {
    progressRatio = Math.max(0, Math.min(1, opts.points / opts.nextThreshold));
  }
  const filledW = Math.round(barW * progressRatio);

  const remaining = opts.nextThreshold == null
    ? 0
    : Math.max(0, Math.ceil(opts.nextThreshold - opts.points));
  const label = opts.labelOverride
    ?? (opts.nextThreshold == null
      ? ''
      : remaining === 0
        ? 'Reward unlocked!'
        : `${remaining} pts to next reward`);

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${opts.bgColor}"/>`);
  // Empty track
  parts.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="${radius}" fill="${toRgba(opts.textColor, 0.22)}"/>`);
  // Filled portion (only if there's progress to show)
  if (filledW > 0) {
    parts.push(`<rect x="${barX}" y="${barY}" width="${filledW}" height="${barH}" rx="${radius}" fill="${toRgba(opts.textColor, 1)}"/>`);
  }
  // Label
  if (label) {
    const labelY = barY + barH + 38;
    parts.push(
      `<text x="${W / 2}" y="${labelY}" font-family="-apple-system, system-ui, sans-serif" font-size="26" font-weight="600" fill="${toRgba(opts.textColor, 1)}" text-anchor="middle">${escapeXml(label)}</text>`,
    );
  }
  parts.push('</svg>');

  try {
    return await sharpMod(Buffer.from(parts.join(''))).png({ compressionLevel: 6 }).toBuffer();
  } catch (err: any) {
    console.warn('[WalletPass] points progress strip render failed:', err?.message);
    return null;
  }
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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
 * - keep the result inside Apple's slot, flush left, vertically centered so
 *   the logo's midline sits at the same Y where iOS renders the logoText
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

    // Horizontal: flush left so the logo stays on the leading edge.
    // Vertical: CENTER within Apple's slot. iOS places the logoText
    // (brand name) at the slot's vertical midline, not at the top — so a
    // logo anchored at top=0 sat visually above the title. Centering the
    // logo aligns its midline with the title's midline for a consistent
    // header baseline regardless of how much the merchant scaled down.
    const left = 0;
    const top = Math.max(0, Math.floor((slotH - targetH) / 2));

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
 * Wallet pass logo scale (percent). Sourced from `loyalty_config.wallet_card_logo_scale`
 * — merchant-controlled via the Loyalty page slider. Falls back to 100% when unset.
 * Clamped to [20, 200] by buildWalletLogoPngBuffers so a malformed config can't
 * produce an oversized artwork that overflows Apple's 160×50pt slot.
 */
function resolveWalletLogoScale(
  loyalty: { wallet_card_logo_scale?: unknown } | null | undefined,
  _appInAppScale: number,
): number {
  const raw = loyalty?.wallet_card_logo_scale;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 100;
  return n;
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

/**
 * Points-mode milestone shape consumed by buildPassJson. Renamed from
 * stamp_number → points_threshold to match the Phase 4 schema rename.
 */
type PointsMilestone = {
  id: string;
  points_threshold: number;
  reward_name: string;
};

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
  expiresLabel: string;
  barcodeMessage: string;
  memberCode: string;
  customerId: string;
  hasLogoImage: boolean;
  templateType?: string;
  locations?: Array<{ lat: number; lng: number; name: string }>;
  loyaltyType?: string;
  cashbackBalance?: number;
  cashbackPercent?: number;
  businessType?: string;
  /**
   * All active points milestones for the merchant, sorted by
   * points_threshold ascending (cheapest first). Front of the pass shows
   * the next 2 unredeemed as secondaryFields and the next 2 as
   * auxiliaryFields. All milestones surface on the back of the pass.
   */
  milestones?: PointsMilestone[];
}): Buffer {
  // Defensive normalization: legacy rows may still carry 'stamps' but the
  // Phase 1-4 contract collapsed stamps→points. Treat anything not
  // explicitly 'cashback' as points so the render path stays predictable.
  const rawType = opts.loyaltyType ?? 'points';
  const loyaltyType: 'cashback' | 'points' = rawType === 'cashback' ? 'cashback' : 'points';

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

  if (loyaltyType === 'cashback') {
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
  } else {
    // ─── Points mode ───
    // Per user feedback, the pass surfaces ONLY the next affordable
    // reward (the customer's immediate target), not the whole catalog.
    //   primary    → POINTS balance
    //   secondary  → NEXT reward name + cost (1 field)
    //   auxiliary  → empty
    //   back       → lifetime points + member code
    // The strip image (built separately) carries the small circular
    // reward thumbnail pulled from Foodics.
    const allMilestones = (opts.milestones ?? [])
      .filter((m) => m && typeof m.points_threshold === 'number' && (m.reward_name || '').trim().length > 0)
      .slice()
      .sort((a, b) => a.points_threshold - b.points_threshold);

    // "Next" = cheapest unaffordable reward. If everything is affordable,
    // show the highest-tier as a stretch goal so the pass isn't empty.
    const displayPoints = Math.max(0, Math.floor(opts.points));
    const nextReward =
      allMilestones.find((m) => m.points_threshold > displayPoints) ??
      allMilestones[allMilestones.length - 1] ??
      null;

    const secondaryFields = nextReward
      ? [
          {
            key: `milestone_${nextReward.id}`,
            label: 'NEXT REWARD',
            value: `${(nextReward.reward_name || '').trim() || '—'} · ${Math.round(nextReward.points_threshold)} pts`,
          },
        ]
      : [];

    storeCard = {
      headerFields: titleHeader,
      primaryFields: [
        { key: 'balance', label: 'POINTS', value: displayPoints },
      ],
      secondaryFields,
      auxiliaryFields: [],
      backFields: [
        { key: 'memberCode', label: 'Member Code', value: opts.memberCode },
        { key: 'lifetime', label: 'LIFETIME POINTS', value: String(Math.max(0, Math.floor(opts.lifetimePoints))) },
        { key: 'branchUse', label: 'In-store use', value: 'Show this barcode at the branch to earn points.' },
        { key: 'redeem', label: 'Redeem', value: 'Points can be used at checkout in the app — pick any reward you can afford.' },
      ],
    };
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

      const expiresLabel = formatExpiryDate(lastEarnDate, config?.expiry_months ?? null);
      const memberProfile = await ensureLoyaltyMemberProfile(merchantId, customerId);

      // Foodics Loyalty Adapter QR format: compact JSON with mobile number + country code.
      // See: https://developers.foodics.com/guides/loyalty.html#qr-code-content
      //
      // customer_name is intentionally omitted: Apple Wallet's barcode
      // messageEncoding is iso-8859-1, which can't represent Arabic
      // characters. Including an Arabic display_name in the JSON makes
      // the encoded byte stream invalid and Apple silently fails to
      // render the QR matrix (showing only the altText). Foodics uses
      // mobile number for lookup, so the name field is decorative —
      // dropping it keeps the QR ASCII-clean and renders reliably for
      // every merchant regardless of language.
      const customerPhone = (memberProfile.phone_number || '').replace(/^\+?966/, '').replace(/^0/, '').trim();
      const barcodeMessage = customerPhone
        ? JSON.stringify({
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

      // Effective type for the customer — same auto-migration contract as
      // the /api/loyalty/balance endpoint (keep old type until balance hits 0,
      // then migrate to the merchant's current config type). Phase 1-4
      // collapsed stamps → points, so normalize any lingering 'stamps'
      // value to 'points' defensively.
      const route = await getCustomerLoyaltyRoute(merchantId, customerId);
      const rawType = route.redeem ?? config?.loyalty_type ?? 'points';
      const loyaltyType: 'cashback' | 'points' = rawType === 'cashback' ? 'cashback' : 'points';

      // Re-read milestones fresh on every pass render so config changes
      // (new reward, threshold tweak) show up immediately when the
      // existing notifyPassUpdate nudges the device. No in-memory cache.
      const [{ data: branches }, { data: cbRow }, { data: milestoneRows }] = await Promise.all([
        supabaseAdmin.from('branch_mappings').select('name, latitude, longitude')
          .eq('merchant_id', merchantId)
          .not('latitude', 'is', null).not('longitude', 'is', null).limit(10),
        supabaseAdmin.from('loyalty_cashback_balances').select('balance_sar')
          .eq('customer_id', customerId).eq('merchant_id', merchantId)
          .order('config_version', { ascending: false }).limit(1).maybeSingle(),
        supabaseAdmin.from('loyalty_milestones').select('id, reward_name, points_threshold')
          .eq('merchant_id', merchantId).eq('is_active', true)
          .order('points_threshold', { ascending: true }),
      ]);
      const activeMilestones = (milestoneRows ?? []) as PointsMilestone[];

      // Points-mode strip: draw a horizontal progress bar to the
      // cheapest UNAFFORDABLE milestone. If the customer can afford
      // every reward, hide the bar and show "All rewards unlocked".
      if (loyaltyType === 'points') {
        const displayPoints = Math.max(0, Math.floor(points));
        const sortedMs = activeMilestones
          .slice()
          .sort((a, b) => a.points_threshold - b.points_threshold);
        const nextUnaffordable = sortedMs.find((m) => m.points_threshold > displayPoints) ?? null;

        let label: string | null;
        let nextThreshold: number | null;
        if (sortedMs.length === 0) {
          label = 'Earn points on every order';
          nextThreshold = null;
        } else if (!nextUnaffordable) {
          label = 'All rewards unlocked — keep earning!';
          nextThreshold = null;
        } else {
          label = null; // helper generates "X pts to next reward"
          nextThreshold = nextUnaffordable.points_threshold;
        }

        const progressStrip = await buildPointsProgressStripPng({
          points: displayPoints,
          nextThreshold,
          bgColor,
          textColor,
          labelOverride: label,
        });
        if (progressStrip) {
          files['strip.png'] = progressStrip;
          files['strip@2x.png'] = progressStrip;
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
        expiresLabel,
        barcodeMessage,
        memberCode: memberProfile.member_code,
        customerId,
        hasLogoImage: !!logoUrl,
        loyaltyType,
        cashbackBalance: cbRow?.balance_sar ?? 0,
        cashbackPercent: config?.cashback_percent ?? 5,
        businessType: config?.business_type ?? 'cafe',
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

/**
 * Phase B observability wrapper. Use this from any loyalty mutation
 * path instead of calling notifyPassUpdate directly + tacking on a
 * `.catch(console.warn)`. The pre-fix pattern logged a generic warn
 * with no merchant_id / customer_id context — an APNS cert expiry
 * would surface as 10+ identical lines per minute with nothing to
 * correlate. This wrapper:
 *   1. enriches the warn log with the (merchant, customer) pair
 *   2. ships to Sentry tagged with merchant_id / customer_id
 *   3. inserts an audit_log row so the merchant dashboard could
 *      surface "pass pushes are failing" without trawling logs
 * Always returns void and never throws — callers can fire-and-forget.
 */
export function notifyPassUpdateSafe(customerId: string, merchantId: string): void {
  notifyPassUpdate(customerId, merchantId).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[Loyalty] notifyPassUpdate failed', { merchantId, customerId, error: message });
    try {
      const [{ captureError }, { writeAudit }] = await Promise.all([
        import('../utils/sentryContext'),
        import('../utils/auditLog'),
      ]);
      captureError(err, {
        component: 'walletPass.notifyPassUpdate',
        merchantId,
        customerId,
      });
      await writeAudit({
        merchant_id: merchantId || null,
        action: 'loyalty.notify_pass_failed',
        payload: { customer_id: customerId, error: message },
      });
    } catch {
      // Observability hooks must never throw.
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

// Diagnostic endpoint to force-refresh a customer's Apple Wallet pass.
// Used when stamps / cashback / balances were updated outside the
// normal loyalty endpoints (e.g. direct SQL UPDATE during manual
// reconciliation) — those edits don't fire notifyPassUpdate, so iOS
// keeps showing the stale pass until the next time the customer
// earns or redeems through the API.
walletPassRouter.post('/wallet-pass/force-refresh', async (req, res) => {
  if (!requireDiagnosticAccess(req, res)) return;
  const customerId = typeof req.body?.customerId === 'string' ? req.body.customerId.trim() : '';
  const merchantId = typeof req.body?.merchantId === 'string' ? req.body.merchantId.trim() : '';
  if (!customerId || !merchantId) {
    return res.status(400).json({ error: 'customerId and merchantId are required' });
  }
  try {
    await notifyPassUpdate(customerId, merchantId);
    res.json({ success: true, customerId, merchantId });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'force-refresh failed' });
  }
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
        points: 0,
        lifetimePoints: 0,
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

    // Determine effective loyalty type: member override > config default.
    // Ask the loyalty module for the customer's effective type — handles
    // the transition contract the same way /api/loyalty/balance does.
    // Phase 1-4 collapsed stamps → points, so normalize any 'stamps' value
    // (legacy member rows, older configs) to 'points'.
    const route = await getCustomerLoyaltyRoute(merchantId, customerId);
    const rawType = route.redeem
      ?? memberLoyaltyInfo?.active_loyalty_type
      ?? config?.loyalty_type
      ?? 'points';
    const loyaltyType: 'cashback' | 'points' = rawType === 'cashback' ? 'cashback' : 'points';

    // Re-read milestones fresh on every pass render so config changes
    // (new reward, threshold tweak) show up immediately when the
    // existing notifyPassUpdate nudges the device.
    const [{ data: branches }, { data: cbRow }, { data: milestoneRows }] = await Promise.all([
      supabaseAdmin.from('branch_mappings').select('name, latitude, longitude')
        .eq('merchant_id', merchantId)
        .not('latitude', 'is', null).not('longitude', 'is', null).limit(10),
      supabaseAdmin.from('loyalty_cashback_balances').select('balance_sar')
        .eq('customer_id', customerId).eq('merchant_id', merchantId)
        .order('config_version', { ascending: false }).limit(1).maybeSingle(),
      supabaseAdmin.from('loyalty_milestones').select('id, reward_name, points_threshold')
        .eq('merchant_id', merchantId).eq('is_active', true)
        .order('points_threshold', { ascending: true }),
    ]);
    const activeMilestones = (milestoneRows ?? []) as PointsMilestone[];

    // Foodics Loyalty Adapter QR format. customer_name omitted because
    // iso-8859-1 messageEncoding can't represent Arabic chars and
    // Apple silently fails to render the QR. See the duplicate logic
    // above for the full explanation.
    const customerPhone2 = (memberProfile.phone_number || '').replace(/^\+?966/, '').replace(/^0/, '').trim();
    const barcodeMessage = customerPhone2
      ? JSON.stringify({
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

    // Points-mode strip: draw a horizontal progress bar to the cheapest
    // UNAFFORDABLE milestone. Special-cases: no milestones configured →
    // "Earn points on every order"; customer can afford every reward →
    // "All rewards unlocked — keep earning!"
    if (loyaltyType === 'points') {
      const displayPoints = Math.max(0, Math.floor(points));
      const sortedMs = activeMilestones
        .slice()
        .sort((a, b) => a.points_threshold - b.points_threshold);
      const nextUnaffordable = sortedMs.find((m) => m.points_threshold > displayPoints) ?? null;

      let label: string | null;
      let nextThreshold: number | null;
      if (sortedMs.length === 0) {
        label = 'Earn points on every order';
        nextThreshold = null;
      } else if (!nextUnaffordable) {
        label = 'All rewards unlocked — keep earning!';
        nextThreshold = null;
      } else {
        label = null;
        nextThreshold = nextUnaffordable.points_threshold;
      }

      const progressStrip = await buildPointsProgressStripPng({
        points: displayPoints,
        nextThreshold,
        bgColor,
        textColor,
        labelOverride: label,
      });
      if (progressStrip) {
        files['strip.png'] = progressStrip;
        files['strip@2x.png'] = progressStrip;
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
      expiresLabel,
      barcodeMessage,
      memberCode: memberProfile.member_code,
      customerId,
      hasLogoImage: !!logoUrl,
      loyaltyType,
      cashbackBalance: cbRow?.balance_sar ?? 0,
      cashbackPercent: config?.cashback_percent ?? 5,
      businessType: config?.business_type ?? 'cafe',
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
