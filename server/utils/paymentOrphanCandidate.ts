import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isReservedClientPaymentId } from './orderFinalizationGuard';

const SAFE_REFERENCE = /^[A-Za-z0-9_-]{1,160}$/;
const MOYASAR_PAYMENT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// A commit can perform several bounded provider/database operations before
// the order row lands. Keep the initial lease comfortably above that work,
// then renew it immediately before money/order-finalization boundaries.
export const COMMIT_LEASE_MS = 15 * 60 * 1000;

export type PaymentOrphanLeaseOwner = 'commit' | 'sweep';

export type PaymentOrphanCandidate = {
  payment_id: string;
  merchant_id: string;
  amount_halalas: number;
  metadata_order_id: string;
  metadata_customer_id: string;
};

export function paymentOrphanManualReviewUpdate(
  attempts: number,
  reason: string,
  terminal: boolean,
  now = new Date().toISOString(),
): {
  resolution: 'manual_review';
  attempts: number;
  last_error: string;
  resolved_at?: string;
  processing_owner: null;
  processing_token: null;
  processing_until: null;
} {
  return {
    resolution: 'manual_review',
    attempts: Math.max(0, attempts) + 1,
    last_error: reason.slice(0, 1000),
    processing_owner: null,
    processing_token: null,
    processing_until: null,
    ...(terminal ? { resolved_at: now } : {}),
  };
}

export function buildCommitPaymentOrphanCandidate(input: {
  paymentId: unknown;
  merchantId: unknown;
  orderId: unknown;
  customerId: unknown;
  totalSar: unknown;
  paymentMethod: unknown;
  walletAmountSar: unknown;
}): PaymentOrphanCandidate | null {
  const paymentId = typeof input.paymentId === 'string' ? input.paymentId.trim() : '';
  const merchantId = typeof input.merchantId === 'string' ? input.merchantId.trim() : '';
  const orderId = typeof input.orderId === 'string' ? input.orderId.trim() : '';
  const customerId = typeof input.customerId === 'string' ? input.customerId.trim() : '';
  if (
    !MOYASAR_PAYMENT_UUID.test(paymentId) ||
    isReservedClientPaymentId(paymentId) ||
    !SAFE_REFERENCE.test(merchantId) ||
    !SAFE_REFERENCE.test(orderId) ||
    !SAFE_REFERENCE.test(customerId)
  ) {
    return null;
  }

  const totalSar = Number(input.totalSar);
  if (!Number.isFinite(totalSar) || totalSar <= 0) return null;
  if (input.paymentMethod === 'wallet') return null;
  const requestedWallet = Number(input.walletAmountSar);
  const walletSar =
    Number.isFinite(requestedWallet) && requestedWallet > 0
      ? Math.min(requestedWallet, totalSar)
      : 0;
  const amountHalalas = Math.round(Math.max(0, totalSar - walletSar) * 100);
  if (!Number.isSafeInteger(amountHalalas) || amountHalalas <= 0) return null;

  return {
    payment_id: paymentId,
    merchant_id: merchantId,
    amount_halalas: amountHalalas,
    metadata_order_id: orderId,
    metadata_customer_id: customerId,
  };
}

type StoredPaymentOrphanCandidate = Omit<
  PaymentOrphanCandidate,
  'metadata_order_id' | 'metadata_customer_id'
> & {
  metadata_order_id: string | null;
  metadata_customer_id: string | null;
  resolved_at: string | null;
  resolution: string | null;
  processing_owner: PaymentOrphanLeaseOwner | null;
  processing_token: string | null;
  processing_until: string | null;
};

const CANDIDATE_SELECT =
  'payment_id, merchant_id, amount_halalas, metadata_order_id, metadata_customer_id, resolved_at, resolution, processing_owner, processing_token, processing_until';

export type PaymentOrphanRegistration =
  | { status: 'active'; leaseToken: string }
  | { status: 'order_found' }
  | { status: 'in_progress' };

export class PaymentOrphanCandidateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentOrphanCandidateConflictError';
  }
}

export class PaymentOrphanCandidateCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentOrphanCandidateCapacityError';
  }
}

export async function upsertPaymentOrphanCandidate(
  admin: SupabaseClient,
  candidate: PaymentOrphanCandidate,
): Promise<PaymentOrphanRegistration> {
  const { error } = await admin
    .from('payment_orphan_candidates')
    .upsert(candidate, {
      onConflict: 'payment_id',
      // Preserve the original first_seen_at and immutable attribution if a
      // provider webhook won the race.
      ignoreDuplicates: true,
    });
  if (error) {
    if (/too many unresolved payment recovery candidates/i.test(error.message)) {
      throw new PaymentOrphanCandidateCapacityError(error.message);
    }
    throw new Error(`payment recovery candidate persistence failed: ${error.message}`);
  }

  const readCandidate = async () => {
    const { data, error: readError } = await admin
      .from('payment_orphan_candidates')
      .select(CANDIDATE_SELECT)
      .eq('payment_id', candidate.payment_id)
      .maybeSingle();
    if (readError) {
      throw new Error(`payment recovery candidate read-back failed: ${readError.message}`);
    }
    return data as StoredPaymentOrphanCandidate | null;
  };

  let stored = await readCandidate();
  if (!stored) {
    throw new Error('payment recovery candidate was not durable after persistence');
  }
  if (
    stored.payment_id !== candidate.payment_id ||
    stored.merchant_id !== candidate.merchant_id ||
    Number(stored.amount_halalas) !== candidate.amount_halalas ||
    stored.metadata_order_id !== candidate.metadata_order_id ||
    stored.metadata_customer_id !== candidate.metadata_customer_id
  ) {
    throw new PaymentOrphanCandidateConflictError(
      'payment recovery candidate conflicts with existing attribution',
    );
  }
  if (stored.resolved_at != null) {
    if (stored.resolution === 'order_found') return { status: 'order_found' };
    throw new PaymentOrphanCandidateConflictError(
      `payment recovery candidate is already terminal (${stored.resolution ?? 'unknown'})`,
    );
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + COMMIT_LEASE_MS).toISOString();
  const leaseToken = randomUUID();
  const { data: claimed, error: claimError } = await admin
    .from('payment_orphan_candidates')
    .update({
      processing_owner: 'commit',
      processing_token: leaseToken,
      processing_until: leaseUntil,
    })
    .eq('payment_id', candidate.payment_id)
    .eq('merchant_id', candidate.merchant_id)
    .eq('amount_halalas', candidate.amount_halalas)
    .eq('metadata_order_id', candidate.metadata_order_id)
    .eq('metadata_customer_id', candidate.metadata_customer_id)
    .is('resolved_at', null)
    .or(
      `processing_owner.is.null,processing_until.is.null,processing_until.lt.${nowIso}`,
    )
    .select(CANDIDATE_SELECT)
    .maybeSingle();
  if (claimError) {
    throw new Error(`payment recovery commit lease failed: ${claimError.message}`);
  }
  if (claimed) {
    const claimedRow = claimed as StoredPaymentOrphanCandidate;
    if (
      claimedRow.processing_owner !== 'commit' ||
      claimedRow.processing_token !== leaseToken
    ) {
      throw new Error('payment recovery commit lease read-back did not preserve ownership');
    }
    return { status: 'active', leaseToken };
  }

  stored = await readCandidate();
  if (
    stored?.resolved_at != null &&
    stored.resolution === 'order_found'
  ) {
    return { status: 'order_found' };
  }
  if (
    stored?.resolved_at == null &&
    stored?.processing_owner != null &&
    stored.processing_token != null &&
    stored.processing_until != null &&
    Date.parse(stored.processing_until) > now.getTime()
  ) {
    return { status: 'in_progress' };
  }
  throw new PaymentOrphanCandidateConflictError(
    'payment recovery candidate could not acquire a commit lease',
  );
}

export async function insertTerminalPaymentOrphanManualReview(
  admin: SupabaseClient,
  candidate: PaymentOrphanCandidate,
  reason: string,
): Promise<void> {
  const resolvedAt = new Date().toISOString();
  const { data, error } = await admin
    .from('payment_orphan_candidates')
    .insert({
      ...candidate,
      resolved_at: resolvedAt,
      resolution: 'manual_review',
      attempts: 0,
      last_error: reason.slice(0, 1000),
      processing_owner: null,
      processing_token: null,
      processing_until: null,
    })
    .select(CANDIDATE_SELECT)
    .single();
  if (error) {
    throw new Error(
      `payment recovery terminal fallback persistence failed: ${error.message}`,
    );
  }
  const stored = data as StoredPaymentOrphanCandidate | null;
  if (
    !stored ||
    stored.payment_id !== candidate.payment_id ||
    stored.merchant_id !== candidate.merchant_id ||
    Number(stored.amount_halalas) !== candidate.amount_halalas ||
    stored.metadata_order_id !== candidate.metadata_order_id ||
    stored.metadata_customer_id !== candidate.metadata_customer_id ||
    stored.resolution !== 'manual_review' ||
    !stored.resolved_at
  ) {
    throw new Error(
      'payment recovery terminal fallback failed its attribution read-back',
    );
  }
}

export async function renewPaymentOrphanLease(
  admin: SupabaseClient,
  paymentId: string,
  owner: PaymentOrphanLeaseOwner,
  leaseToken: string,
  ttlMs: number,
): Promise<boolean> {
  const now = new Date();
  const processingUntil = new Date(now.getTime() + ttlMs).toISOString();
  const { data, error } = await admin
    .from('payment_orphan_candidates')
    .update({ processing_until: processingUntil })
    .eq('payment_id', paymentId)
    .eq('processing_owner', owner)
    .eq('processing_token', leaseToken)
    .is('resolved_at', null)
    .gt('processing_until', now.toISOString())
    .select('payment_id')
    .maybeSingle();
  if (error) {
    throw new Error(`payment recovery lease renewal failed: ${error.message}`);
  }
  return Boolean(data);
}

export async function releasePaymentOrphanLease(
  admin: SupabaseClient,
  paymentId: string,
  owner: PaymentOrphanLeaseOwner,
  leaseToken: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from('payment_orphan_candidates')
    .update({
      processing_owner: null,
      processing_token: null,
      processing_until: null,
    })
    .eq('payment_id', paymentId)
    .eq('processing_owner', owner)
    .eq('processing_token', leaseToken)
    .is('resolved_at', null)
    .select('payment_id')
    .maybeSingle();
  if (error) {
    throw new Error(`payment recovery lease release failed: ${error.message}`);
  }
  return Boolean(data);
}

export async function markPaymentOrphanCandidateOrderFound(
  admin: SupabaseClient,
  paymentId: string,
  leaseToken: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from('payment_orphan_candidates')
    .update({
      resolved_at: nowIso,
      resolution: 'order_found',
      processing_owner: null,
      processing_token: null,
      processing_until: null,
    })
    .eq('payment_id', paymentId)
    .eq('processing_owner', 'commit')
    .eq('processing_token', leaseToken)
    .is('resolved_at', null)
    .gt('processing_until', nowIso)
    .select('payment_id')
    .maybeSingle();
  if (error) {
    throw new Error(`payment recovery candidate close failed: ${error.message}`);
  }
  if (!data) {
    throw new Error('payment recovery candidate close lost commit lease ownership');
  }
}

export async function markPaymentOrphanCandidateManualReview(
  admin: SupabaseClient,
  paymentId: string,
  leaseToken: string,
  reason: string,
  terminal: boolean,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from('payment_orphan_candidates')
    .update({
      resolution: 'manual_review',
      last_error: reason.slice(0, 1000),
      processing_owner: null,
      processing_token: null,
      processing_until: null,
      ...(terminal ? { resolved_at: nowIso } : {}),
    })
    .eq('payment_id', paymentId)
    .eq('processing_owner', 'commit')
    .eq('processing_token', leaseToken)
    .is('resolved_at', null)
    .gt('processing_until', nowIso)
    .select('payment_id')
    .maybeSingle();
  if (error) {
    throw new Error(`payment recovery manual-review persistence failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      'payment recovery manual-review persistence lost commit lease ownership',
    );
  }
}
