export type LoyaltyMode = 'cashback' | 'points';

export function chooseInitialLoyaltyMode(input: {
  merchantMode: LoyaltyMode;
  pointsBalance: number;
  cashbackBalance: number;
}): LoyaltyMode {
  const points = Math.max(0, Number(input.pointsBalance) || 0);
  const cashback = Math.max(0, Number(input.cashbackBalance) || 0);

  if (input.merchantMode === 'points' && cashback > 0 && points === 0) return 'cashback';
  if (input.merchantMode === 'cashback' && points > 0 && cashback === 0) return 'points';
  return input.merchantMode;
}

export function shouldKeepExistingLoyaltyMode(input: {
  merchantMode: LoyaltyMode;
  customerMode: LoyaltyMode;
  existingBalance: number;
}): boolean {
  return input.customerMode !== input.merchantMode && Number(input.existingBalance) > 0;
}
