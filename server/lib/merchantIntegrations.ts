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
  source: 'merchant' | 'fallback';
};

export type MerchantDeliveryRuntimeConfig = {
  merchantId: string | null;
  environment: 'sandbox' | 'production';
  deliveryEnabled: boolean;
  status: 'disconnected' | 'connected' | 'error';
  refreshToken: string | null;
  source: 'merchant' | 'fallback';
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

  if (!merchantId || !supabaseAdmin) return fallback;

  const { data, error } = await supabaseAdmin
    .from('merchant_payment_settings')
    .select('*')
    .eq('merchant_id', merchantId)
    .maybeSingle();

  if (error || !data) return fallback;

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
    customerPaymentsEnabled: Boolean(data.customer_payments_enabled),
    applePayEnabled: Boolean(data.apple_pay_enabled),
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
    source: 'fallback',
  };

  if (!merchantId || !supabaseAdmin) return fallback;

  const { data, error } = await supabaseAdmin
    .from('merchant_delivery_settings')
    .select('*')
    .eq('merchant_id', merchantId)
    .maybeSingle();

  if (error || !data) return fallback;

  const environment = data.environment === 'sandbox' ? 'sandbox' : 'production';
  const refreshTokenEnc =
    environment === 'sandbox' ? data.test_refresh_token_enc : data.live_refresh_token_enc;

  return {
    merchantId,
    environment,
    deliveryEnabled: Boolean(data.delivery_enabled),
    status: data.status === 'error' ? 'error' : data.status === 'connected' ? 'connected' : 'disconnected',
    refreshToken: safeDecrypt(refreshTokenEnc, null),
    source: 'merchant',
  };
}
