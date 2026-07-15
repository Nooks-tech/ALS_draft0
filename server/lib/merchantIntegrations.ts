import { createClient } from '@supabase/supabase-js';
import { decryptMerchantCredential, hasMerchantCredential } from './merchantCredentials';
import { captureError } from '../utils/sentryContext';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

function normalizeOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeDecrypt(value: unknown, fallback: string | null, merchantId?: string | null) {
  const encryptedValue = normalizeOptionalString(value);
  if (!hasMerchantCredential(encryptedValue)) return fallback;
  try {
    return decryptMerchantCredential(encryptedValue);
  } catch (err) {
    console.error(
      '[merchantIntegrations] credential decrypt failed:',
      err instanceof Error ? err.message : err
    );
    captureError(err, { component: 'merchantIntegrations.decrypt', merchantId });
    return fallback;
  }
}

export type MerchantPaymentRuntimeConfig = {
  merchantId: string | null;
  environment: 'sandbox' | 'production';
  customerPaymentsEnabled: boolean;
  applePayEnabled: boolean;
  applePayMerchantId: string | null;
  publishableKey: string | null;
  secretKey: string | null;
  webhookSecret: string | null;
  source: 'merchant' | 'fallback' | 'missing';
};

export type MerchantDeliveryRuntimeConfig = {
  merchantId: string | null;
  environment: 'sandbox' | 'production';
  deliveryEnabled: boolean;
  status: 'disconnected' | 'connected' | 'error';
  refreshToken: string | null;
  /** Comma-separated carrier filter (e.g. "careem,mrsool,dal"). Null = use env default. */
  preferredCarriers: string | null;
  source: 'merchant' | 'fallback' | 'missing';
};

export function getSupabaseAdminClient() {
  return supabaseAdmin;
}

// 60s TTL cache. The order-commit path verifies the payment up to three
// times and each verify re-fetched merchant_payment_settings + merchants
// (2 queries × ~250ms Railway→Tokyo RTT) for config that changes ~never.
// Payment settings are edited on the nooksweb dashboard (a different
// service), so a short TTL — not cross-service invalidation — is the
// consistency model; 60s of staleness on a key rotation is acceptable.
const PAYMENT_CONFIG_TTL_MS = 60_000;
const paymentConfigCache = new Map<string, { at: number; value: MerchantPaymentRuntimeConfig }>();

export async function getMerchantPaymentRuntimeConfig(
  merchantId?: string | null
): Promise<MerchantPaymentRuntimeConfig> {
  const cacheKey = merchantId ?? '';
  const cached = paymentConfigCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PAYMENT_CONFIG_TTL_MS) return cached.value;
  const value = await fetchMerchantPaymentRuntimeConfig(merchantId);
  paymentConfigCache.set(cacheKey, { at: Date.now(), value });
  // Opportunistic prune so one-time merchant ids can't grow the map forever.
  if (paymentConfigCache.size > 2000) {
    const cutoff = Date.now() - PAYMENT_CONFIG_TTL_MS;
    for (const [k, v] of paymentConfigCache) {
      if (v.at < cutoff) paymentConfigCache.delete(k);
    }
  }
  return value;
}

async function fetchMerchantPaymentRuntimeConfig(
  merchantId?: string | null
): Promise<MerchantPaymentRuntimeConfig> {
  const fallback: MerchantPaymentRuntimeConfig = {
    merchantId: merchantId ?? null,
    environment: 'production',
    customerPaymentsEnabled: Boolean(process.env.MOYASAR_SECRET_KEY),
    applePayEnabled: Boolean(process.env.EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID),
    applePayMerchantId: normalizeOptionalString(process.env.EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID),
    publishableKey: normalizeOptionalString(process.env.EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY),
    secretKey: normalizeOptionalString(process.env.MOYASAR_SECRET_KEY),
    webhookSecret: normalizeOptionalString(process.env.MOYASAR_WEBHOOK_SECRET),
    source: 'fallback',
  };

  if (!merchantId) return fallback;
  if (!supabaseAdmin) {
    return {
      merchantId,
      environment: 'production',
      customerPaymentsEnabled: false,
      applePayEnabled: false,
      applePayMerchantId: null,
      publishableKey: null,
      secretKey: null,
      webhookSecret: null,
      source: 'missing',
    };
  }

  const [{ data, error }, { data: merchant }, { data: latestSub }] = await Promise.all([
    supabaseAdmin
      .from('merchant_payment_settings')
      .select('*')
      .eq('merchant_id', merchantId)
      .maybeSingle(),
    supabaseAdmin
      .from('merchants')
      .select('status, trial_ends_at, deleted_at')
      .eq('id', merchantId)
      .maybeSingle(),
    // REG-1: latest subscription row for the payment-policy gate below.
    supabaseAdmin
      .from('subscriptions')
      .select('status, current_period_end_at, expires_at')
      .eq('merchant_id', merchantId)
      .order('current_period_end_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (error || !data) {
    return {
      merchantId,
      environment: 'production',
      customerPaymentsEnabled: false,
      applePayEnabled: false,
      applePayMerchantId: null,
      publishableKey: null,
      secretKey: null,
      webhookSecret: null,
      source: 'missing',
    };
  }

  // REG-1: gate customer payments on the EFFECTIVE subscription policy, not
  // just an explicit `status='suspended'`. This mirrors the order-intake gate
  // in server/routes/orders.ts so the payment-initiate paths (Moyasar invoice,
  // STC Pay, saved-card token) agree with order-commit on who may transact.
  // Allowed: active free trial, healthy active subscription, cancelled/expired
  // sub still inside its paid period, or a lapsed/past-due sub within grace.
  // Denied: soft-deleted, suspended, expired trial with no subscription, or a
  // lapsed sub past grace. Only applied when the merchant row actually
  // resolved — a null/transient read must not lock out a legitimately-active
  // merchant (matches the prior suspended-only behavior on a null merchant).
  const SUBSCRIPTION_GRACE_MS = 2 * 24 * 60 * 60 * 1000; // SUBSCRIPTION_GRACE_PERIOD_DAYS (nooksweb)
  const nowMs = Date.now();
  const parseMs = (v: unknown): number | null => {
    if (typeof v !== 'string' || !v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  };

  let paymentsPolicyAllowed = true;
  if (merchant) {
    const trialEndsMs = parseMs(merchant.trial_ends_at);
    const trialActive = trialEndsMs != null && trialEndsMs > nowMs;
    const merchantStatus =
      typeof merchant.status === 'string' ? merchant.status.trim().toLowerCase() : null;

    if (merchant.deleted_at) {
      paymentsPolicyAllowed = false;
    } else if (merchantStatus === 'suspended') {
      paymentsPolicyAllowed = false;
    } else if (!latestSub) {
      // Never subscribed: open only while the free trial runs.
      paymentsPolicyAllowed = trialActive;
    } else {
      const subStatus = typeof latestSub.status === 'string' ? latestSub.status : '';
      const periodEndMs =
        parseMs(latestSub.current_period_end_at) ?? parseMs(latestSub.expires_at);
      if (subStatus === 'cancelled' || subStatus === 'expired') {
        // Auto-renew off / ended: valid until the paid period actually ends.
        paymentsPolicyAllowed = periodEndMs != null && periodEndMs > nowMs;
      } else if (
        subStatus === 'past_due' ||
        (subStatus === 'active' && periodEndMs != null && periodEndMs <= nowMs)
      ) {
        // Renewal failed or the period lapsed — allowed only within grace.
        const graceEndMs = periodEndMs != null ? periodEndMs + SUBSCRIPTION_GRACE_MS : null;
        paymentsPolicyAllowed = graceEndMs != null && nowMs <= graceEndMs;
      } else {
        // Healthy active subscription (period still open / renewed).
        paymentsPolicyAllowed = true;
      }
    }
  }

  const environment = data.environment === 'sandbox' ? 'sandbox' : 'production';
  const publishableKeyEnc =
    environment === 'sandbox' ? data.test_publishable_key_enc : data.live_publishable_key_enc;
  const secretKeyEnc =
    environment === 'sandbox' ? data.test_secret_key_enc : data.live_secret_key_enc;
  const webhookSecretEnc =
    environment === 'sandbox' ? data.test_webhook_secret_enc : data.live_webhook_secret_enc;

  return {
    merchantId,
    environment,
    customerPaymentsEnabled: paymentsPolicyAllowed && Boolean(data.customer_payments_enabled),
    applePayEnabled: paymentsPolicyAllowed && Boolean(data.apple_pay_enabled),
    applePayMerchantId: normalizeOptionalString(data.apple_pay_merchant_id),
    publishableKey: safeDecrypt(publishableKeyEnc, null, merchantId),
    secretKey: safeDecrypt(secretKeyEnc, null, merchantId),
    webhookSecret: safeDecrypt(webhookSecretEnc, null, merchantId),
    source: 'merchant',
  };
}

export async function getMerchantDeliveryRuntimeConfig(
  merchantId?: string | null
): Promise<MerchantDeliveryRuntimeConfig> {
  const fallback: MerchantDeliveryRuntimeConfig = {
    merchantId: merchantId ?? null,
    environment: 'production',
    deliveryEnabled: Boolean(process.env.OTO_REFRESH_TOKEN),
    status: process.env.OTO_REFRESH_TOKEN ? 'connected' : 'disconnected',
    refreshToken: normalizeOptionalString(process.env.OTO_REFRESH_TOKEN),
    preferredCarriers: normalizeOptionalString(process.env.OTO_PREFERRED_CARRIERS),
    source: 'fallback',
  };

  if (!merchantId) return fallback;
  if (!supabaseAdmin) {
    return {
      merchantId,
      environment: 'production',
      deliveryEnabled: false,
      status: 'disconnected',
      refreshToken: null,
      preferredCarriers: null,
      source: 'missing',
    };
  }

  const [{ data, error }, { data: merchant }] = await Promise.all([
    supabaseAdmin
      .from('merchant_delivery_settings')
      .select('*')
      .eq('merchant_id', merchantId)
      .maybeSingle(),
    supabaseAdmin
      .from('merchants')
      .select('status')
      .eq('id', merchantId)
      .maybeSingle(),
  ]);

  if (error || !data) {
    return {
      merchantId,
      environment: 'production',
      deliveryEnabled: false,
      status: 'disconnected',
      refreshToken: null,
      preferredCarriers: null,
      source: 'missing',
    };
  }

  const merchantStatus =
    typeof merchant?.status === 'string' ? merchant.status.trim().toLowerCase() : '';
  const merchantIsSuspended = merchantStatus === 'suspended';

  const environment = data.environment === 'sandbox' ? 'sandbox' : 'production';
  const refreshTokenEnc =
    environment === 'sandbox' ? data.test_refresh_token_enc : data.live_refresh_token_enc;

  return {
    merchantId,
    environment,
    deliveryEnabled: !merchantIsSuspended && Boolean(data.delivery_enabled),
    status:
      merchantIsSuspended
        ? 'disconnected'
        : data.status === 'error'
          ? 'error'
          : data.status === 'connected'
            ? 'connected'
            : 'disconnected',
    refreshToken: safeDecrypt(refreshTokenEnc, null, merchantId),
    preferredCarriers: normalizeOptionalString(data.preferred_carriers),
    source: 'merchant',
  };
}
