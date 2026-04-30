/**
 * Client-side Moyasar tokenization (save-only).
 *
 * The customer enters card details into our own UI; we use the
 * Moyasar React Native SDK's `createToken` helper (which posts
 * directly to /v1/tokens with the merchant's PUBLISHABLE key — public
 * — and `save_only: true`) so no payment is charged. The token
 * comes back; we then forward it to /api/payment/saved-cards/attach
 * which re-verifies it with the secret key and persists it to
 * customer_saved_cards.
 *
 * Card data flows client → Moyasar directly (skipping our server),
 * which keeps raw PANs out of our PCI scope.
 *
 * Why use the SDK helper instead of a manual fetch?
 *   1. The SDK is already bundled (we render the in-app payment
 *      result paths via it) and has the Buffer-based base64 auth
 *      header that Moyasar expects, with the right SDK headers.
 *   2. Replicating its TokenRequest body shape and error handling
 *      from scratch invites subtle bugs.
 */
import { createToken, isMoyasarError, TokenRequest } from 'react-native-moyasar-sdk';

// Moyasar's hosted return page for 3DS. Posting a token with
// callback_url forces this page to load after 3DS so we can detect
// completion in the WebView.
const TOKEN_RETURN_URL = 'https://sdk.moyasar.com/return';
const MOYASAR_BASE_URL = 'https://api.moyasar.com';

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
 * Hit Moyasar's /v1/tokens endpoint via the bundled SDK helper. Returns
 * the token (which may require 3DS verification — see verification_url).
 */
export async function createMoyasarToken(input: CreateTokenInput): Promise<CreateTokenResponse> {
  const { publishableKey, name, number, cvc, month, year, metadata } = input;

  if (!publishableKey) {
    throw new MoyasarTokenError('Moyasar publishable key is missing');
  }

  const tokenRequest = new TokenRequest({
    name,
    number,
    cvc,
    month,
    year,
    baseUrl: MOYASAR_BASE_URL,
    callbackUrl: TOKEN_RETURN_URL,
    metadata: metadata ?? null,
  });

  const result = await createToken(tokenRequest, publishableKey);

  if (isMoyasarError(result)) {
    // The SDK's NetworkEndpointError wraps the raw Moyasar error body.
    // Try to surface the most specific message we have.
    const anyResult = result as any;
    const apiError = anyResult?.error;
    const message =
      apiError?.message ||
      anyResult?.message ||
      'Moyasar token creation failed';
    throw new MoyasarTokenError(message, result);
  }

  // SDK shapes camelCase; flatten back to the snake_case shape we use
  // throughout the rest of the app + verification_url naming.
  return {
    id: result.id,
    status: result.status,
    brand: result.brand,
    funding: result.funding,
    country: result.country,
    month: result.month,
    year: result.year,
    name: result.name,
    last_four: result.lastFour,
    verification_url: result.verificationUrl ?? undefined,
    message: result.message ?? undefined,
  };
}
