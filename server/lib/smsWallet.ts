import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEFAULT_LOW_BALANCE_THRESHOLD_HALALAS = 3000;
const DEFAULT_CHARGE_PER_OTP_HALALAS = 20;

const adminClient =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

type WalletRow = {
  balance_halalas?: number | null;
  low_balance_threshold_halalas?: number | null;
  charge_per_otp_halalas?: number | null;
  enforcement_enabled?: boolean | null;
};

type WalletRpcRow = {
  applied?: boolean | null;
  balance_halalas?: number | null;
  low_balance_threshold_halalas?: number | null;
  charge_per_otp_halalas?: number | null;
  enforcement_enabled?: boolean | null;
  reason?: string | null;
};

export type MerchantSmsWalletRuntime = {
  merchantId: string;
  merchantFound: boolean;
  enforcementEnabled: boolean;
  balanceHalalas: number;
  lowBalanceThresholdHalalas: number;
  chargePerOtpHalalas: number;
  state: 'inactive' | 'active' | 'low_balance' | 'blocked';
};

function intOrDefault(value: number | null | undefined, fallback: number) {
  return Number.isFinite(value) ? Math.max(0, Math.round(Number(value))) : fallback;
}

function stateFromWallet(input: {
  enforcementEnabled: boolean;
  balanceHalalas: number;
  lowBalanceThresholdHalalas: number;
  chargePerOtpHalalas: number;
}): MerchantSmsWalletRuntime['state'] {
  if (!input.enforcementEnabled) return 'inactive';
  if (input.balanceHalalas < input.chargePerOtpHalalas) return 'blocked';
  if (input.balanceHalalas <= input.lowBalanceThresholdHalalas) return 'low_balance';
  return 'active';
}

function mapRuntime(merchantId: string, merchantFound: boolean, row?: WalletRow | null): MerchantSmsWalletRuntime {
  const enforcementEnabled = Boolean(row?.enforcement_enabled);
  const balanceHalalas = intOrDefault(row?.balance_halalas, 0);
  const lowBalanceThresholdHalalas = intOrDefault(
    row?.low_balance_threshold_halalas,
    DEFAULT_LOW_BALANCE_THRESHOLD_HALALAS
  );
  const chargePerOtpHalalas =
    intOrDefault(row?.charge_per_otp_halalas, DEFAULT_CHARGE_PER_OTP_HALALAS) ||
    DEFAULT_CHARGE_PER_OTP_HALALAS;

  return {
    merchantId,
    merchantFound,
    enforcementEnabled,
    balanceHalalas,
    lowBalanceThresholdHalalas,
    chargePerOtpHalalas,
    state: stateFromWallet({
      enforcementEnabled,
      balanceHalalas,
      lowBalanceThresholdHalalas,
      chargePerOtpHalalas,
    }),
  };
}

function rpcRow(data: unknown) {
  if (Array.isArray(data)) {
    return (data[0] ?? null) as WalletRpcRow | null;
  }
  return (data ?? null) as WalletRpcRow | null;
}

export async function getMerchantSmsWalletRuntime(
  merchantId?: string | null
): Promise<MerchantSmsWalletRuntime | null> {
  if (!merchantId || !adminClient) return null;

  const [merchantQuery, walletQuery] = await Promise.all([
    adminClient.from('merchants').select('id').eq('id', merchantId).maybeSingle(),
    adminClient
      .from('merchant_sms_wallets')
      .select(
        'balance_halalas, low_balance_threshold_halalas, charge_per_otp_halalas, enforcement_enabled'
      )
      .eq('merchant_id', merchantId)
      .maybeSingle(),
  ]);

  if (merchantQuery.error) {
    throw new Error(merchantQuery.error.message);
  }
  if (walletQuery.error) {
    throw new Error(walletQuery.error.message);
  }

  return mapRuntime(merchantId, Boolean(merchantQuery.data), (walletQuery.data ?? null) as WalletRow | null);
}

export async function debitMerchantSmsWallet(params: {
  merchantId: string;
  referenceId: string;
  phone: string;
  amountHalalas?: number;
  note?: string;
  metadata?: Record<string, unknown>;
}) {
  if (!adminClient) {
    return {
      ok: false,
      charged: false,
      reason: 'not_configured' as const,
      balanceHalalas: 0,
      chargePerOtpHalalas: DEFAULT_CHARGE_PER_OTP_HALALAS,
    };
  }

  const runtime = await getMerchantSmsWalletRuntime(params.merchantId);
  if (!runtime?.merchantFound) {
    return {
      ok: false,
      charged: false,
      reason: 'merchant_not_found' as const,
      balanceHalalas: runtime?.balanceHalalas ?? 0,
      chargePerOtpHalalas: runtime?.chargePerOtpHalalas ?? DEFAULT_CHARGE_PER_OTP_HALALAS,
    };
  }

  const { data, error } = await adminClient.rpc('debit_sms_wallet_balance', {
    p_merchant_id: params.merchantId,
    p_amount_halalas: params.amountHalalas ?? runtime.chargePerOtpHalalas,
    p_reference_id: params.referenceId,
    p_phone: params.phone,
    p_message_id: null,
    p_note: params.note ?? 'OTP verification SMS',
    p_metadata: params.metadata ?? {},
  });

  if (error) {
    // Defensive: if the RPC doesn't exist (nooksweb migrations not applied), allow OTP
    if (error.message.includes('does not exist') || error.message.includes('could not find')) {
      console.warn('[smsWallet] RPC debit_sms_wallet_balance not found — allowing OTP (wallet not migrated)');
      return {
        ok: true,
        charged: false,
        reason: 'not_configured' as const,
        balanceHalalas: 0,
        chargePerOtpHalalas: runtime.chargePerOtpHalalas,
      };
    }
    throw new Error(error.message);
  }

  const row = rpcRow(data);
  const reason = (row?.reason ?? 'unknown') as
    | 'debited'
    | 'not_enforced'
    | 'insufficient_balance'
    | 'already_applied'
    | 'unknown';
  const newBalanceHalalas = intOrDefault(row?.balance_halalas, runtime.balanceHalalas);
  const chargePerOtpHalalas =
    intOrDefault(row?.charge_per_otp_halalas, runtime.chargePerOtpHalalas) ||
    runtime.chargePerOtpHalalas;

  // Threshold alert — fire-and-forget email when this debit pushed the
  // wallet across the merchant's low-balance threshold for the first
  // time since their last top-up. Idempotency is enforced on the
  // nooksweb side via audit_log (action=sms_wallet.threshold_alert)
  // so a flood of OTPs after the cross only sends one email.
  if (
    reason === 'debited' &&
    Boolean(row?.applied) &&
    runtime.balanceHalalas >= runtime.lowBalanceThresholdHalalas &&
    newBalanceHalalas < runtime.lowBalanceThresholdHalalas
  ) {
    fireThresholdAlert({
      merchantId: params.merchantId,
      balanceHalalas: newBalanceHalalas,
      thresholdHalalas: runtime.lowBalanceThresholdHalalas,
      chargePerOtpHalalas,
    });
  }

  return {
    ok: reason === 'debited' || reason === 'not_enforced' || reason === 'already_applied',
    charged: Boolean(row?.applied),
    reason,
    balanceHalalas: newBalanceHalalas,
    chargePerOtpHalalas,
  };
}

const NOOKS_API_BASE_URL = (
  process.env.NOOKS_API_BASE_URL ||
  process.env.EXPO_PUBLIC_NOOKS_API_BASE_URL ||
  ''
).trim().replace(/\/+$/, '');
const NOOKS_INTERNAL_SECRET = (process.env.NOOKS_INTERNAL_SECRET || '').trim();

function fireThresholdAlert(opts: {
  merchantId: string;
  balanceHalalas: number;
  thresholdHalalas: number;
  chargePerOtpHalalas: number;
}) {
  if (!NOOKS_API_BASE_URL || !NOOKS_INTERNAL_SECRET) return;
  fetch(`${NOOKS_API_BASE_URL}/api/public/sms-wallet/threshold-alert`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-nooks-internal-secret': NOOKS_INTERNAL_SECRET,
    },
    body: JSON.stringify(opts),
  }).catch((e) => console.warn('[smsWallet] threshold-alert relay failed:', e?.message));
}

export async function creditMerchantSmsWallet(params: {
  merchantId: string;
  referenceId: string;
  amountHalalas: number;
  note?: string;
  metadata?: Record<string, unknown>;
}) {
  if (!adminClient) {
    return { ok: false };
  }

  const { error } = await adminClient.rpc('credit_sms_wallet_balance', {
    p_merchant_id: params.merchantId,
    p_amount_halalas: params.amountHalalas,
    p_reference_id: params.referenceId,
    p_entry_type: 'reversal',
    p_note: params.note ?? 'SMS wallet reversal',
    p_payment_id: null,
    p_metadata: params.metadata ?? {},
  });

  if (error) {
    throw new Error(error.message);
  }

  return { ok: true };
}
