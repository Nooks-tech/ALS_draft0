/**
 * Client-side Moyasar tokenization (default flow).
 *
 * The customer enters card details into our own UI; we POST directly
 * to Moyasar's /v1/tokens with the merchant's PUBLISHABLE key — public
 * — omitting `save_only` entirely. This runs Moyasar's DEFAULT
 * tokenization flow: a 1-SAR authorization that Moyasar auto-voids,
 * plus 3DS verification via the returned `verification_url`. Once the
 * customer completes 3DS, the token's status becomes "active" and the
 * token is reusable for later charges (unlike the old save_only:true
 * tokens, which are single-use and never become reusable per Moyasar's
 * docs). The token comes back; we then forward it to
 * /api/payment/saved-cards/attach which re-verifies it with the secret
 * key and persists it to customer_saved_cards.
 *
 * Card data flows client → Moyasar directly (skipping our server),
 * which keeps raw PANs out of our PCI scope.
 *
 * Why a manual fetch instead of the bundled SDK helper?
 *   The SDK's TokenRequest.toJson() hardcodes `save_only: true`
 *   (node_modules/react-native-moyasar-sdk/src/models/api/api_requests/
 *   token_request.ts) with no way to opt out, so it cannot produce a
 *   reusable token. We replicate its Buffer-based base64 auth header
 *   (no trailing colon on the publishable key) and JSON body shape by
 *   hand instead.
 */
import { Buffer } from 'buffer';

// Moyasar's hosted return page for 3DS. Posting a token with
// callback_url forces this page to load after 3DS so we can detect
// completion in the WebView.
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
  detail: any;
  constructor(message: string, detail?: any) {
    super(message);
    this.name = 'MoyasarTokenError';
    this.detail = detail;
  }
}

/**
 * Hit Moyasar's /v1/tokens endpoint directly (default flow — no
 * save_only). Returns the token, which requires 3DS verification via
 * verification_url before it becomes active/reusable.
 */
export async function createMoyasarToken(input: CreateTokenInput): Promise<CreateTokenResponse> {
  const { publishableKey, name, number, cvc, month, year, metadata } = input;

  if (!publishableKey) {
    throw new MoyasarTokenError('Moyasar publishable key is missing');
  }

  const res = await fetch('https://api.moyasar.com/v1/tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(publishableKey).toString('base64')}`,
    },
    body: JSON.stringify({
      name,
      number,
      cvc,
      month,
      year,
      callback_url: TOKEN_RETURN_URL,
      metadata: metadata ?? null,
    }),
  });

  const text = await res.text().catch(() => '');
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!res.ok) {
    // Mirror the server's error-message pattern (server/services/payment.ts):
    // flatten Moyasar's per-field `errors` dict, preferring it over the
    // top-level message since it's the more actionable detail.
    const fieldErrors =
      body?.errors && typeof body.errors === 'object'
        ? Object.entries(body.errors)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? (v as string[]).join(', ') : v}`)
            .join('; ')
        : '';
    const message = fieldErrors || body?.message || 'Moyasar token creation failed';
    throw new MoyasarTokenError(message, body);
  }

  return {
    id: body.id,
    status: body.status,
    brand: body.brand,
    funding: body.funding,
    country: body.country,
    month: body.month,
    year: body.year,
    name: body.name,
    last_four: body.last_four,
    verification_url: body.verification_url ?? undefined,
    message: body.message ?? undefined,
  };
}
