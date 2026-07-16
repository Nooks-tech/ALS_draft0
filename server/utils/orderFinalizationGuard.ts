export const RESERVED_CLIENT_PAYMENT_PREFIXES = ['wallet:', 'reward:', 'cashback:'] as const;

export type ReservedClientPaymentPrefix = (typeof RESERVED_CLIENT_PAYMENT_PREFIXES)[number];

const CARD_LIKE_PAYMENT_METHODS = new Set([
  'apple_pay',
  'credit_card',
  'saved_card',
  // Legacy/provider-flavoured labels remain compatible. The label never
  // authorizes payment; a successful provider read-back still does.
  'card',
  'mada',
  'visa',
  'mastercard',
  'amex',
  'stcpay',
]);

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedHalalas(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

export function reservedClientPaymentPrefix(value: unknown): ReservedClientPaymentPrefix | null {
  const paymentId = normalizedString(value).toLowerCase();
  return RESERVED_CLIENT_PAYMENT_PREFIXES.find((prefix) => paymentId.startsWith(prefix)) ?? null;
}

export function isReservedClientPaymentId(value: unknown): boolean {
  return reservedClientPaymentPrefix(value) !== null;
}

/** Any reward-prefixed line is reward-bearing, even when its id is malformed. */
export function hasRewardBearingOrderItems(items: unknown): boolean {
  return Array.isArray(items) && items.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const uniqueId = (item as { uniqueId?: unknown }).uniqueId;
    return typeof uniqueId === 'string' && uniqueId.startsWith('reward-');
  });
}

/**
 * Kill-switch for the Phase A blanket reward-checkout block. Default OFF —
 * behavior is unchanged (every reward-bearing request still gets the 409
 * below) until this is explicitly flipped on. Once ON, the pre-charge
 * per-milestone REWARD_UNAUTHORIZED gate in orders.ts (product binding +
 * redeemability check, see authorizeRewardMilestoneForCommit in loyalty.ts)
 * becomes the real defense. Read once at module load.
 */
export const REWARD_CHECKOUT_ENABLED = process.env.REWARD_CHECKOUT_ENABLED === 'true';

export type FinalizationRequestDecision =
  | { ok: true; stage: 'draft'; tender: 'draft' }
  | { ok: true; stage: 'final'; tender: 'provider' | 'wallet' }
  | {
      ok: false;
      status: 400 | 409;
      code: string;
      error: string;
      /**
       * A card-like request may already have charged before either /commit.
       * This is only a candidate: callers must strictly bind it to the order
       * and amount before attempting a provider reversal.
       */
      providerPaymentIdToReverse?: string;
    };

/**
 * Pure pre-side-effect guard for the legacy /commit request shape.
 *
 * Old saved-card clients may create a non-final draft without a payment id.
 * Synthetic ids are never accepted from the client, and a final commit must
 * describe a tender for which the server can subsequently prove settlement.
 */
export function guardOrderFinalizationRequest(input: {
  isFinalCommit: boolean;
  submittedPaymentId: unknown;
  paymentMethod: unknown;
  cardPortionHalalas: unknown;
  walletAppliedHalalas: unknown;
  hasRewardBearingItems: boolean;
}): FinalizationRequestDecision {
  const paymentMethod = normalizedString(input.paymentMethod).toLowerCase();
  const submittedPaymentId = normalizedString(input.submittedPaymentId);
  const cardPortionHalalas = normalizedHalalas(input.cardPortionHalalas);
  const reservedPrefix = reservedClientPaymentPrefix(submittedPaymentId);
  // Deliberately NOT gated on CARD_LIKE_PAYMENT_METHODS: the method is an
  // untrusted client label, and "is there a real provider payment worth
  // reversing?" must not depend on the client getting that label right. Gating
  // on it made this mutually exclusive with the PAYMENT_METHOD_INVALID branch
  // below — which rejects precisely when the label ISN'T card-like — so the
  // one rejection most likely to be holding an already-captured charge could
  // never reverse it. (Proven live 2026-07-16: a commit with paymentMethod
  // 'creditcard' left a genuinely paid charge stranded.) What makes a reversal
  // safe is the caller's strict order+amount binding before it mutates
  // anything, not the label — same reasoning as the note on the set above.
  const providerPaymentIdToReverse =
    cardPortionHalalas > 0
    && submittedPaymentId
    && !reservedPrefix
      ? submittedPaymentId
      : null;

  // Reward-bearing drafts must fail before saved-card token-pay can charge.
  // Direct card/Apple Pay may arrive only after charging on either commit, so
  // surface the strictly-bind-before-reversal candidate whenever one exists.
  // Flag-gated: once REWARD_CHECKOUT_ENABLED, fall through to the normal
  // draft/final-commit checks below — the pre-charge gate in orders.ts is
  // the real defense against an unauthorized reward.
  if ((input.hasRewardBearingItems || paymentMethod === 'reward') && !REWARD_CHECKOUT_ENABLED) {
    return {
      ok: false,
      status: 409,
      code: 'REWARD_CHECKOUT_TEMPORARILY_DISABLED',
      error: 'Reward checkout is temporarily unavailable while secure reward reservations are enabled.',
      ...(providerPaymentIdToReverse ? { providerPaymentIdToReverse } : {}),
    };
  }

  if (reservedPrefix) {
    return {
      ok: false,
      status: 409,
      code: 'CLIENT_PAYMENT_SENTINEL_FORBIDDEN',
      error: `Client-authored ${reservedPrefix} payment identifiers cannot finalize an order.`,
    };
  }

  if (!input.isFinalCommit) {
    return { ok: true, stage: 'draft', tender: 'draft' };
  }

  const walletAppliedHalalas = normalizedHalalas(input.walletAppliedHalalas);
  if (cardPortionHalalas > 0) {
    if (!CARD_LIKE_PAYMENT_METHODS.has(paymentMethod)) {
      return {
        ok: false,
        status: 400,
        code: 'PAYMENT_METHOD_INVALID',
        error: 'A card-funded final commit requires a supported card payment method.',
        ...(providerPaymentIdToReverse ? { providerPaymentIdToReverse } : {}),
      };
    }
    if (!normalizedString(input.submittedPaymentId)) {
      return {
        ok: false,
        status: 409,
        code: 'PAYMENT_ID_REQUIRED',
        error: 'A real provider payment identifier is required before this order can be finalized.',
      };
    }
    return { ok: true, stage: 'final', tender: 'provider' };
  }

  if (walletAppliedHalalas > 0) {
    // The request label is only a hint. deriveFinalSettlementProof below will
    // require the transaction id returned by the server-side debit and will
    // canonicalize the stored method to `wallet`.
    return { ok: true, stage: 'final', tender: 'wallet' };
  }

  return {
    ok: false,
    status: 409,
    code: 'SETTLEMENT_PROOF_REQUIRED',
    error: 'This zero-charge order has no server-verifiable settlement proof.',
  };
}

export type FinalSettlementProof =
  | { settled: false; paymentId: null; paymentMethod: null; reason: string }
  | {
      settled: true;
      paymentId: string;
      paymentMethod: string;
      tender: 'provider' | 'wallet' | 'mixed';
    };

/**
 * Converts completed server actions into the only value allowed to stamp
 * payment_confirmed_at / queue / relay. Request strings never constitute
 * proof: provider tender needs a successful read-back and wallet tender needs
 * the transaction id returned by the server-side debit.
 */
export function deriveFinalSettlementProof(input: {
  isFinalCommit: boolean;
  providerPaymentId: unknown;
  providerPaymentMethod: unknown;
  providerVerified: boolean;
  cardPortionHalalas: unknown;
  walletAppliedHalalas: unknown;
  walletDebitTransactionId: unknown;
}): FinalSettlementProof {
  if (!input.isFinalCommit) {
    return { settled: false, paymentId: null, paymentMethod: null, reason: 'draft' };
  }

  const cardPortionHalalas = normalizedHalalas(input.cardPortionHalalas);
  const walletAppliedHalalas = normalizedHalalas(input.walletAppliedHalalas);
  const providerPaymentId = normalizedString(input.providerPaymentId);
  const walletDebitTransactionId = normalizedString(input.walletDebitTransactionId);

  if (cardPortionHalalas <= 0 && walletAppliedHalalas <= 0) {
    return { settled: false, paymentId: null, paymentMethod: null, reason: 'no-funded-component' };
  }
  if (
    cardPortionHalalas > 0 &&
    (!input.providerVerified || !providerPaymentId || isReservedClientPaymentId(providerPaymentId))
  ) {
    return { settled: false, paymentId: null, paymentMethod: null, reason: 'provider-not-verified' };
  }
  if (walletAppliedHalalas > 0 && !walletDebitTransactionId) {
    return { settled: false, paymentId: null, paymentMethod: null, reason: 'wallet-debit-not-proven' };
  }

  if (cardPortionHalalas > 0) {
    const rawMethod = normalizedString(input.providerPaymentMethod).toLowerCase();
    const paymentMethod = CARD_LIKE_PAYMENT_METHODS.has(rawMethod) ? rawMethod : 'credit_card';
    return {
      settled: true,
      paymentId: providerPaymentId,
      paymentMethod,
      tender: walletAppliedHalalas > 0 ? 'mixed' : 'provider',
    };
  }

  return {
    settled: true,
    paymentId: `wallet:${walletDebitTransactionId}`,
    paymentMethod: 'wallet',
    tender: 'wallet',
  };
}
