import { createClient } from '@supabase/supabase-js';
import { decryptMerchantCredential, hasMerchantCredential } from './merchantCredentials';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

function normalizeOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeDecrypt(value: unknown, fallback: string | null) {
  const encryptedValue = normalizeOptionalString(value);
  if (!hasMerchantCredential(encryptedValue)) return fallback;
  try {
    return decryptMerchantCredential(encryptedValue);
  } catch {
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

export async function getMerchantPaymentRuntimeConfig(
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

  const [{ data, error }, { data: merchant }] = await Promise.all([
    supabaseAdmin
      .from('merchant_payment_settings')
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
      customerPaymentsEnabled: false,
      applePayEnabled: false,
      applePayMerchantId: null,
      publishableKey: null,
      secretKey: null,
      webhookSecret: null,
      source: 'missing',
    };
  }

  const merchantStatus =
    typeof merchant?.status === 'string' ? merchant.status.trim().toLowerCase() : '';
  const merchantIsSuspended = merchantStatus === 'suspended';

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
    customerPaymentsEnabled: !merchantIsSuspended && Boolean(data.customer_payments_enabled),
    applePayEnabled: !merchantIsSuspended && Boolean(data.apple_pay_enabled),
    applePayMerchantId: normalizeOptionalString(data.apple_pay_merchant_id),
    publishableKey: safeDecrypt(publishableKeyEnc, null),
    secretKey: safeDecrypt(secretKeyEnc, null),
    webhookSecret: safeDecrypt(webhookSecretEnc, null),
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
    refreshToken: safeDecrypt(refreshTokenEnc, null),
    preferredCarriers: normalizeOptionalString(data.preferred_carriers),
    source: 'merchant',
  };
}
