/**
 * Narrow server-side adapter for the dormant Phase C database commands.
 *
 * Deliberately absent from routes until the database migration, Phase B
 * attempt cutover, and end-to-end tests are approved. Every economic identity
 * and amount is derived in SQL; callers can pass identifiers and choices only.
 */

type RpcResult<T> = Promise<{ data: T | null; error: { message?: string } | null }>;

export interface PhaseCRpcClient {
  rpc<T = unknown>(name: string, args: Record<string, unknown>): RpcResult<T>;
}

export interface PhaseCFeatureConfiguration {
  walletCommands: boolean;
  loyaltyCommands: boolean;
  promoCommands: boolean;
  rewardReservations: boolean;
  checkoutCommit: boolean;
  reservationExpiryWorker: boolean;
  foodicsType2Rewards: boolean;
  foodicsType2SandboxContractProven: boolean;
}

const enabled = (value: string | undefined): boolean => value === 'true';

export function readPhaseCFeatureConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): PhaseCFeatureConfiguration {
  return {
    walletCommands: enabled(env.PHASE_C_WALLET_COMMANDS_ENABLED),
    loyaltyCommands: enabled(env.PHASE_C_LOYALTY_COMMANDS_ENABLED),
    promoCommands: enabled(env.PHASE_C_PROMO_COMMANDS_ENABLED),
    rewardReservations: enabled(env.PHASE_C_REWARD_RESERVATIONS_ENABLED),
    checkoutCommit: enabled(env.PHASE_C_CHECKOUT_COMMIT_ENABLED),
    reservationExpiryWorker: enabled(env.PHASE_C_RESERVATION_EXPIRY_WORKER_ENABLED),
    foodicsType2Rewards: enabled(env.PHASE_C_FOODICS_TYPE2_REWARDS_ENABLED),
    foodicsType2SandboxContractProven:
      env.FOODICS_TYPE2_SANDBOX_CONTRACT_PROVEN === 'YES',
  };
}
export function assertPhaseCFeatureConfiguration(
  config: PhaseCFeatureConfiguration,
): void {
  if (
    config.checkoutCommit &&
    (!config.walletCommands || !config.loyaltyCommands || !config.promoCommands)
  ) {
    throw new Error(
      'PHASE_C_CHECKOUT_COMMIT_ENABLED requires wallet, loyalty, and promo commands',
    );
  }
  if (
    config.foodicsType2Rewards &&
    (!config.rewardReservations || !config.foodicsType2SandboxContractProven)
  ) {
    throw new Error(
      'Foodics Type 2 rewards require exact-product reservations and authenticated sandbox contract proof',
    );
  }
}

async function callRpc<T>(
  db: PhaseCRpcClient,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await db.rpc<T>(name, args);
  if (error || data == null) {
    throw new Error(error?.message || `${name} returned no result`);
  }
  return data;
}

export function createPhaseCValueCommands(db: PhaseCRpcClient) {
  return {
    creditCapturedTopup(topupIntentId: string): Promise<string> {
      return callRpc<string>(db, 'credit_wallet_from_topup_intent', {
        p_topup_intent_id: topupIntentId,
      });
    },

    reserveWallet(input: {
      paymentAttemptId: string;
      paymentComponentId: string;
      idempotencyKey: string;
    }): Promise<string> {
      return callRpc<string>(db, 'reserve_wallet_for_attempt', {
        p_payment_attempt_id: input.paymentAttemptId,
        p_payment_component_id: input.paymentComponentId,
        p_idempotency_key: input.idempotencyKey,
      });
    },

    reserveCashback(input: {
      paymentAttemptId: string;
      paymentComponentId: string;
      idempotencyKey: string;
    }): Promise<string> {
      return callRpc<string>(db, 'reserve_cashback_for_attempt', {
        p_payment_attempt_id: input.paymentAttemptId,
        p_payment_component_id: input.paymentComponentId,
        p_idempotency_key: input.idempotencyKey,
      });
    },

    reserveExactProductReward(input: {
      paymentAttemptId: string;
      quoteLineId: string;
      milestoneProductId: string;
      quantity: number;
      idempotencyKey: string;
    }): Promise<string> {
      return callRpc<string>(db, 'reserve_reward_for_attempt', {
        p_payment_attempt_id: input.paymentAttemptId,
        p_quote_line_id: input.quoteLineId,
        p_milestone_product_id: input.milestoneProductId,
        p_quantity: input.quantity,
        p_idempotency_key: input.idempotencyKey,
      });
    },

    reservePromo(input: {
      paymentAttemptId: string;
      quoteAdjustmentId: string;
      idempotencyKey: string;
    }): Promise<string> {
      return callRpc<string>(db, 'reserve_promo_for_attempt', {
        p_payment_attempt_id: input.paymentAttemptId,
        p_quote_adjustment_id: input.quoteAdjustmentId,
        p_idempotency_key: input.idempotencyKey,
      });
    },

    commitCheckout(input: {
      quoteId: string;
      paymentAttemptId: string;
      orderId: string;
      idempotencyKey: string;
    }): Promise<string> {
      return callRpc<string>(db, 'commit_checkout_with_reservations', {
        p_quote_id: input.quoteId,
        p_payment_attempt_id: input.paymentAttemptId,
        p_order_id: input.orderId,
        p_client_idempotency_key: input.idempotencyKey,
      });
    },

    releaseTerminalAttempt(input: {
      paymentAttemptId: string;
      reason: 'attempt_failed' | 'attempt_cancelled' | 'attempt_expired';
    }): Promise<number> {
      return callRpc<number>(db, 'release_attempt_reservations', {
        p_payment_attempt_id: input.paymentAttemptId,
        p_reason_code: input.reason,
      });
    },
  };
}
