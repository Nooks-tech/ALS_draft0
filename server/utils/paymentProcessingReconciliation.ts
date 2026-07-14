import crypto from 'crypto';

export type PaymentProcessingCandidate = {
  id: string;
  merchant_id: string;
  payment_id: string;
  status: string;
  payment_method: string | null;
  total_sar: string | number;
  card_paid_sar: string | number | null;
  wallet_paid_sar: string | number | null;
  cashback_paid_sar: string | number | null;
  payment_confirmed_at: string | null;
  refund_status: string | null;
  refund_amount: string | number | null;
  refunded_at: string | null;
  commission_status: string | null;
  commission_amount: string | number | null;
  created_at: string;
  updated_at: string | null;
  environment: string | null;
  live_secret_key_enc: string | null;
  test_secret_key_enc: string | null;
};

export type MoyasarPaymentEvidence = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
  source?: { company?: string | null } | null;
  fee?: number | null;
  refunded_amount?: number | null;
};

export type VerifiedPaymentEvidence = {
  id: string;
  merchantId: string;
  paymentId: string;
  providerStatus: string;
  providerAmount: number;
  providerCurrency: 'SAR';
  providerCreatedAt: string | null;
  providerUpdatedAt: string | null;
  providerCompany: string | null;
  providerFee: number | null;
  providerRefundedAmount: number | null;
  metadataOrderId: string | null;
  metadataMerchantId: string | null;
  legacyMetadataException: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_PROVIDER_STATES = new Set(['paid', 'captured', 'failed', 'voided', 'refunded']);
const LEGACY_METADATA_CUTOFF_MS = Date.parse('2026-06-01T00:00:00.000Z');

function finiteNumber(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not finite`);
  return parsed;
}

function timestampMs(value: string | null | undefined, label: string): number {
  if (!value) throw new Error(`${label} is missing`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

export function expectedProviderAmountHalalas(candidate: PaymentProcessingCandidate): number {
  const cardPaid = finiteNumber(candidate.card_paid_sar ?? 0, 'card_paid_sar');
  const total = finiteNumber(candidate.total_sar, 'total_sar');
  const expectedSar = cardPaid > 0 ? cardPaid : total;
  const halalas = Math.round(expectedSar * 100);
  if (!Number.isSafeInteger(halalas) || halalas <= 0) {
    throw new Error('expected provider amount must be a positive safe integer');
  }
  return halalas;
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedCandidate(candidate: PaymentProcessingCandidate) {
  return {
    id: candidate.id,
    merchant_id: candidate.merchant_id,
    payment_id: candidate.payment_id,
    status: candidate.status,
    payment_method: candidate.payment_method,
    total_sar: finiteNumber(candidate.total_sar, 'total_sar'),
    card_paid_sar: finiteNumber(candidate.card_paid_sar ?? 0, 'card_paid_sar'),
    wallet_paid_sar: finiteNumber(candidate.wallet_paid_sar ?? 0, 'wallet_paid_sar'),
    cashback_paid_sar: finiteNumber(candidate.cashback_paid_sar ?? 0, 'cashback_paid_sar'),
    payment_confirmed_at: candidate.payment_confirmed_at,
    refund_status: candidate.refund_status,
    refund_amount: finiteNumber(candidate.refund_amount ?? 0, 'refund_amount'),
    refunded_at: candidate.refunded_at,
    commission_status: candidate.commission_status,
    commission_amount:
      candidate.commission_amount == null
        ? null
        : finiteNumber(candidate.commission_amount, 'commission_amount'),
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
    environment: candidate.environment,
    live_secret_key_enc: candidate.live_secret_key_enc,
    test_secret_key_enc: candidate.test_secret_key_enc,
  };
}

export function candidateSnapshotHash(candidates: PaymentProcessingCandidate[]): string {
  const normalized = [...candidates]
    .sort((a, b) => `${a.created_at}:${a.id}`.localeCompare(`${b.created_at}:${b.id}`))
    .map(normalizedCandidate);
  return sha256(JSON.stringify(normalized));
}

function assertDatabaseState(candidate: PaymentProcessingCandidate, providerStatus: string): void {
  if (!UUID_RE.test(candidate.payment_id)) throw new Error('payment_id is not a UUID');
  if (!candidate.id || !candidate.merchant_id) throw new Error('order identity is incomplete');
  if (candidate.commission_status != null && candidate.commission_status !== 'pending') {
    throw new Error(`commission_status is no longer repairable: ${candidate.commission_status}`);
  }
  const amount = candidate.commission_amount == null
    ? null
    : finiteNumber(candidate.commission_amount, 'commission_amount');
  if (amount != null && amount !== 0 && amount !== 1) {
    throw new Error(`unexpected commission_amount: ${amount}`);
  }

  if (providerStatus === 'paid' || providerStatus === 'captured') {
    if (candidate.status !== 'Delivered') {
      throw new Error(`${providerStatus} payment is not attached to a Delivered order`);
    }
    return;
  }
  if (providerStatus === 'failed') {
    if (
      candidate.status !== 'Cancelled' ||
      candidate.refund_status !== 'not_required' ||
      finiteNumber(candidate.refund_amount ?? 0, 'refund_amount') !== 0
    ) {
      throw new Error('failed payment does not match the terminal no-refund DB state');
    }
    return;
  }
  if (providerStatus === 'voided' || providerStatus === 'refunded') {
    const refundAmount = finiteNumber(candidate.refund_amount ?? 0, 'refund_amount');
    if (
      candidate.status !== 'Cancelled' ||
      !['refunded', 'voided'].includes(candidate.refund_status ?? '') ||
      refundAmount <= 0
    ) {
      throw new Error(`${providerStatus} payment does not match the terminal refunded DB state`);
    }
  }
}

function legacyMetadataExceptionAllowed(
  candidate: PaymentProcessingCandidate,
  provider: MoyasarPaymentEvidence,
): boolean {
  if (provider.status.toLowerCase() !== 'voided') return false;
  if (provider.amount !== 24_900) return false;
  if (candidate.status !== 'Cancelled' || candidate.refund_status !== 'refunded') return false;
  if (finiteNumber(candidate.refund_amount ?? 0, 'refund_amount') !== finiteNumber(candidate.total_sar, 'total_sar')) {
    return false;
  }
  const orderCreated = timestampMs(candidate.created_at, 'order.created_at');
  const providerCreated = timestampMs(provider.created_at, 'provider.created_at');
  const providerUpdated = timestampMs(provider.updated_at, 'provider.updated_at');
  // The single pre-refunded_at legacy row predates that audit column. Its
  // terminal row update timestamp is the only persisted DB-side reversal
  // timestamp; newer rows must continue to use refunded_at.
  const orderRefunded = timestampMs(candidate.refunded_at ?? candidate.updated_at, 'order refund timestamp');
  return (
    orderCreated < LEGACY_METADATA_CUTOFF_MS &&
    Math.abs(providerCreated - orderCreated) <= 120_000 &&
    Math.abs(orderRefunded - providerUpdated) <= 10_000
  );
}

export function verifyMoyasarPayment(
  candidate: PaymentProcessingCandidate,
  provider: MoyasarPaymentEvidence,
): VerifiedPaymentEvidence {
  const providerStatus = String(provider.status ?? '').trim().toLowerCase();
  if (provider.id !== candidate.payment_id) throw new Error('provider payment id mismatch');
  if (!TERMINAL_PROVIDER_STATES.has(providerStatus)) {
    throw new Error(`provider payment is not in a supported terminal state: ${providerStatus || '(empty)'}`);
  }
  if (String(provider.currency ?? '').trim().toUpperCase() !== 'SAR') {
    throw new Error(`provider currency is not SAR: ${provider.currency}`);
  }
  if (provider.amount !== expectedProviderAmountHalalas(candidate)) {
    throw new Error(`provider amount mismatch: expected ${expectedProviderAmountHalalas(candidate)}, got ${provider.amount}`);
  }
  assertDatabaseState(candidate, providerStatus);

  const metadata = provider.metadata && typeof provider.metadata === 'object' ? provider.metadata : {};
  const metadataOrderId = typeof metadata.order_id === 'string' && metadata.order_id.trim()
    ? metadata.order_id.trim()
    : null;
  const metadataMerchantId = typeof metadata.merchant_id === 'string' && metadata.merchant_id.trim()
    ? metadata.merchant_id.trim()
    : null;

  if (metadataOrderId && metadataOrderId !== candidate.id) throw new Error('provider metadata order_id mismatch');
  if (metadataMerchantId && metadataMerchantId !== candidate.merchant_id) {
    throw new Error('provider metadata merchant_id mismatch');
  }

  let legacyMetadataException = false;
  if (!metadataOrderId || !metadataMerchantId) {
    if (metadataOrderId || metadataMerchantId) {
      throw new Error('provider metadata is only partially populated');
    }
    if (!legacyMetadataExceptionAllowed(candidate, provider)) {
      throw new Error('provider metadata is absent and does not match the single legacy exception');
    }
    legacyMetadataException = true;
  }

  return {
    id: candidate.id,
    merchantId: candidate.merchant_id,
    paymentId: candidate.payment_id,
    providerStatus,
    providerAmount: provider.amount,
    providerCurrency: 'SAR',
    providerCreatedAt: provider.created_at ?? null,
    providerUpdatedAt: provider.updated_at ?? null,
    providerCompany: provider.source?.company ?? null,
    providerFee: provider.fee ?? null,
    providerRefundedAmount: provider.refunded_amount ?? null,
    metadataOrderId,
    metadataMerchantId,
    legacyMetadataException,
  };
}
