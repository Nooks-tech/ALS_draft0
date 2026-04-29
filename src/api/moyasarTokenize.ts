/**
 * Client-side Moyasar tokenization (save-only).
 *
 * The customer enters card details into our own UI; we POST them
 * directly to Moyasar's /v1/tokens with the merchant's PUBLISHABLE
 * key (public — safe to ship in the app) and `save_only: true` so no
 * payment is charged. The token comes back; we then forward it to
 * /api/payment/saved-cards/attach which re-verifies it with the
 * secret key and persists it to customer_saved_cards.
 *
 * Card data flows client → Moyasar directly (skipping our server),
 * which keeps raw PANs out of our PCI scope.
 */

const MOYASAR_BASE = 'https://api.moyasar.com';

// Moyasar's hosted return page for 3DS. Posting a token with
// callback_url forces this page to load after 3DS so the SDK can
// detect completion. We use the same domain the official SDK uses.
const TOKEN_RETURN_URL = 'https://sdk.moyasar.com/return';

export type CreateTokenInput = {
  publishableKey: string;
  name: string;
  number: string; // digits only, no spaces
  cvc: string;
  /** Two-digit month, e.g. "07". */
  month: string;
  /** Four-digit year, e.g. "2030". */
  year: string;
  metadata?: Record<string, string | number | boolean>;
};

export type CreateTokenResponse = {
  id: string;
  /** "active" | "verified" | "inactive" | "failed" */
  status: string;
  brand?: string;
  funding?: string;
  country?: string;
  month?: string;
  year?: string;
  name?: string;
  last_four?: string;
  /** Set when 3DS verification is required. Open in webview, on completion the token becomes verified. */
  verification_url?: string;
  message?: string;
};

export class MoyasarTokenError extends Error {
  status: number;
  detail: any;
  constructor(message: string, status: number, detail?: any) {
    super(message);
    this.name = 'MoyasarTokenError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Hit Moyasar's /v1/tokens endpoint directly. Returns the raw token
 * (which may require 3DS verification — see verification_url).
 */
export async function createMoyasarToken(input: CreateTokenInput): Promise<CreateTokenResponse> {
  const { publishableKey, name, number, cvc, month, year, metadata } = input;

  if (!publishableKey) {
    throw new MoyasarTokenError('Moyasar publishable key is missing', 400);
  }

  const auth = `Basic ${base64Encode(`${publishableKey}:`)}`;

  const body = {
    name,
    number,
    cvc,
    month,
    year,
    save_only: true,
    callback_url: TOKEN_RETURN_URL,
    ...(metadata ? { metadata } : {}),
  };

  const res = await fetch(`${MOYASAR_BASE}/v1/tokens`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* response body wasn't JSON */
  }

  if (!res.ok) {
    const detailMessage =
      data?.message ||
      (data?.errors ? JSON.stringify(data.errors) : null) ||
      `Moyasar /v1/tokens failed with status ${res.status}`;
    throw new MoyasarTokenError(detailMessage, res.status, data);
  }

  return data as CreateTokenResponse;
}

/** Tiny base64 helper that works in RN without a Node Buffer. */
function base64Encode(s: string): string {
  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(s);
  }
  // RN runtime exposes btoa via the URL polyfill in modern releases;
  // fall through to a manual implementation as a safety net.
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c1 = s.charCodeAt(i++) & 0xff;
    const c2 = s.charCodeAt(i++) & 0xff;
    const c3 = s.charCodeAt(i++) & 0xff;
    const e1 = c1 >> 2;
    const e2 = ((c1 & 3) << 4) | (c2 >> 4);
    const e3 = ((c2 & 15) << 2) | (c3 >> 6);
    const e4 = c3 & 63;
    if (isNaN(c2)) {
      out += chars.charAt(e1) + chars.charAt(e2) + '==';
    } else if (isNaN(c3)) {
      out += chars.charAt(e1) + chars.charAt(e2) + chars.charAt(e3) + '=';
    } else {
      out += chars.charAt(e1) + chars.charAt(e2) + chars.charAt(e3) + chars.charAt(e4);
    }
  }
  return out;
}
