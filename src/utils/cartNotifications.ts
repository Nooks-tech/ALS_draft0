/**
 * Cart abandonment notifications — DEPRECATED on the device side.
 *
 * Phase D moved the abandonment flow to a server-side cron driven by
 * the customer_carts table:
 *   - 15 minutes of cart idle → server push "your cart is waiting"
 *   - 1 hour of cart idle → row moved to abandoned_carts, cart cleared
 *
 * The previous device-local schedule fired only when the app went to
 * background and the device kept it alive. Server-driven push reaches
 * the customer even after they swipe-killed the app and works across
 * devices the customer might pick up later.
 *
 * The exports below stay for back-compat with callers in CartContext
 * that haven't been updated yet. They're harmless no-ops; eventually
 * the call sites should be removed entirely.
 *
 * CART_TTL_MS is still used as the local-cache expiry guard — when
 * the app rehydrates an old AsyncStorage cart payload, anything older
 * than this gets wiped before the server sync reseeds.
 */

export const CART_TTL_MS = 12 * 60 * 60 * 1000;

// No-op shims — kept so we don't have to fan out the rename across
// CartContext today. Safe to delete once CartContext stops calling
// them.
export async function cancelAbandonedCartReminder(_reminderKey: string): Promise<void> {
  return;
}

export async function scheduleAbandonedCartReminder(_args: {
  reminderKey: string;
  brandName: string;
  itemCount: number;
  isArabic: boolean;
}): Promise<void> {
  return;
}
