import type {
  CancelPaymentResult,
  VerifyPaidPaymentOptions,
  VerifyPaymentResult,
} from '../services/payment';
import { classifyProviderReversalResult } from './refundDecision';

export type RejectedFinalPaymentCleanupResult =
  | {
      bindingVerified: false;
      providerMutationAttempted: false;
      submittedPaymentId: string;
      reason: string;
      retryable: boolean;
    }
  | {
      bindingVerified: true;
      providerMutationAttempted: true;
      submittedPaymentId: string;
      resolvedPaymentId: string;
      reversal: CancelPaymentResult;
      disposition: ReturnType<typeof classifyProviderReversalResult>;
    };

export type RejectedFinalPaymentDeps = {
  verify: (
    paymentId: string,
    expectedAmountHalalas: number,
    merchantId: string,
    expectedOrderId: string,
    options: VerifyPaidPaymentOptions,
  ) => Promise<VerifyPaymentResult>;
  cancel: (
    paymentId: string,
    amountHalalas: number | undefined,
    merchantId: string,
  ) => Promise<CancelPaymentResult>;
};

/**
 * Strict bind-before-mutate orchestration for a payment that may already have
 * charged before /commit rejects the order. Missing/mismatched binding never
 * reaches cancel, closing the arbitrary-payment-id refund/void DoS.
 */
export async function reverseStrictlyBoundRejectedPayment(
  input: {
    submittedPaymentId: string;
    expectedAmountHalalas: number;
    merchantId: string;
    orderId: string;
  },
  deps: RejectedFinalPaymentDeps,
): Promise<RejectedFinalPaymentCleanupResult> {
  let verification: VerifyPaymentResult;
  try {
    verification = await deps.verify(
      input.submittedPaymentId,
      input.expectedAmountHalalas,
      input.merchantId,
      input.orderId,
      { requireOrderBinding: true },
    );
  } catch (error: any) {
    return {
      bindingVerified: false,
      providerMutationAttempted: false,
      submittedPaymentId: input.submittedPaymentId,
      reason: error?.message || 'strict payment binding threw',
      retryable: false,
    };
  }

  if (!verification.ok) {
    return {
      bindingVerified: false,
      providerMutationAttempted: false,
      submittedPaymentId: input.submittedPaymentId,
      reason: verification.reason,
      retryable: !!verification.retryable,
    };
  }

  let reversal: CancelPaymentResult;
  try {
    reversal = await deps.cancel(verification.moyasarId, undefined, input.merchantId);
  } catch (error: any) {
    reversal = {
      method: 'failed',
      fee: 0,
      moyasarId: verification.moyasarId,
      error: error?.message || 'provider reversal threw',
    };
  }

  return {
    bindingVerified: true,
    providerMutationAttempted: true,
    submittedPaymentId: input.submittedPaymentId,
    resolvedPaymentId: verification.moyasarId,
    reversal,
    disposition: classifyProviderReversalResult(
      reversal.method,
      input.expectedAmountHalalas / 100,
    ),
  };
}
