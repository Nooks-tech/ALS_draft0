/**
 * Validate required environment variables at process startup. Boot hard
 * instead of failing five minutes into the first request — you'll see the
 * list of missing vars in the Railway deploy log and can fix them before
 * anyone tries to place an order.
 *
 * This module is imported at the very top of server/index.ts.
 */

const REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NOOKS_API_BASE_URL',
  'NOOKS_INTERNAL_SECRET',
  'EXPO_ACCESS_TOKEN',
] as const;

// Optional vars surface a warning but do not abort. Listed so prod deploys
// notice missing-but-recommended config before customers complain.
//
// MOYASAR_SECRET_KEY is the platform-level Nooks account key used only as a
// sandbox-verification fallback in the payment webhook (routes/payment.ts).
// Real customer payments go through per-merchant BYOG keys stored encrypted
// in merchant_payment_settings, so the server runs fine without it.
const RECOMMENDED_VARS = [
  'ALLOWED_ORIGINS',
  'FOODICS_CLIENT_ID',
  'FOODICS_CLIENT_SECRET',
  'GITHUB_TOKEN',
  'GITHUB_REPO',
  'RESEND_API_KEY',
  'MOYASAR_SECRET_KEY',
] as const;

export function validateEnv(): void {
  const missing = REQUIRED_VARS.filter((k) => !(process.env[k] ?? '').trim());
  if (missing.length > 0) {
    console.error(
      '[startup] Missing required environment variables:\n  - ' +
        missing.join('\n  - ') +
        "\nSet them in the deployment environment and restart. Aborting.",
    );
    process.exit(1);
  }
  const missingRecommended = RECOMMENDED_VARS.filter((k) => !(process.env[k] ?? '').trim());
  if (missingRecommended.length > 0) {
    console.warn(
      '[startup] Recommended env vars not set (non-fatal):\n  - ' + missingRecommended.join('\n  - '),
    );
  }
  console.log('[startup] Environment validation passed.');
}
