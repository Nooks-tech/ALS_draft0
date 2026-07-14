export type CardReversalMethod = 'void' | 'refund' | 'failed' | 'not_required' | 'unknown' | 'skipped';

export type ProviderReversalState =
  | 'returned'
  | 'nothing_owed'
  | 'unknown'
  | 'failed'
  | 'not_applicable';

function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Number(n.toFixed(2))) : 0;
}

/**
 * Pure decision boundary for the temporary cancellation flow. The card amount
 * is deliberately never included in walletCreditSar: switching rails after a
 * failed or ambiguous provider write is an explicit/manual business action,
 * not an error fallback.
 */
export function decideCardReversal(input: {
  method: CardReversalMethod;
  cardAmountSar: unknown;
  actualWalletPaidSar: unknown;
}): {
  providerState: ProviderReversalState;
  cardReturnedToCustomer: boolean;
  cardNothingOwed: boolean;
  walletCreditSar: number;
} {
  const cardAmountSar = money(input.cardAmountSar);
  const walletCreditSar = money(input.actualWalletPaidSar);

  let providerState: ProviderReversalState;
  if (cardAmountSar <= 0) providerState = 'not_applicable';
  else if (input.method === 'void' || input.method === 'refund') providerState = 'returned';
  else if (input.method === 'not_required') providerState = 'nothing_owed';
  else if (input.method === 'unknown') providerState = 'unknown';
  else providerState = 'failed';

  return {
    providerState,
    cardReturnedToCustomer: providerState === 'returned',
    cardNothingOwed: providerState === 'nothing_owed',
    walletCreditSar,
  };
}

export type TemporaryRefundStatus = 'refunded' | 'not_required' | 'provider_unknown' | 'refund_failed';

export function temporaryRefundStatus(
  providerState: ProviderReversalState,
  hasConfirmedLocalRestoration: boolean,
): TemporaryRefundStatus {
  if (providerState === 'unknown') return 'provider_unknown';
  if (providerState === 'failed') return 'refund_failed';
  if (providerState === 'returned' || hasConfirmedLocalRestoration) return 'refunded';
  return 'not_required';
}

export function classifyProviderReversalResult(
  method: CardReversalMethod,
  cardAmountSar: unknown,
): {
  refundStatus: TemporaryRefundStatus;
  refundMethod: 'card' | 'none';
  refundedSar: number;
  completed: boolean;
  pending: boolean;
  manualReview: boolean;
} {
  const amountSar = money(cardAmountSar);
  if (method === 'void' || method === 'refund') {
    return {
      refundStatus: 'refunded',
      refundMethod: 'card',
      refundedSar: amountSar,
      completed: true,
      pending: false,
      manualReview: false,
    };
  }
  if (method === 'unknown') {
    return {
      refundStatus: 'provider_unknown',
      refundMethod: 'card',
      refundedSar: 0,
      completed: false,
      pending: true,
      manualReview: false,
    };
  }
  if (method === 'failed') {
    return {
      refundStatus: 'refund_failed',
      refundMethod: 'card',
      refundedSar: 0,
      completed: false,
      pending: false,
      manualReview: true,
    };
  }
  return {
    refundStatus: 'not_required',
    refundMethod: 'none',
    refundedSar: 0,
    completed: true,
    pending: false,
    manualReview: false,
  };
}
