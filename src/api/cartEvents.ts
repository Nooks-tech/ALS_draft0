import { API_URL } from './config';
import { supabase } from './supabase';

/**
 * Phase 5 — fire-and-forget cart event reporting.
 *
 * Posts to /api/analytics/cart-event on the Express API. Both calls
 * (cart open and cart commit) are fire-and-forget: we never block the
 * UI on the response and we never surface errors to the user. Server
 * logs are the source of truth if something goes wrong.
 *
 * Used by:
 *   - app/cart.tsx (on screen mount → "cart.opened")
 *   - app/checkout.tsx (after a successful order commit → "cart.committed")
 */

type CartEvent = 'cart.opened' | 'cart.committed';

let cachedSessionId: string | null = null;

function generateSessionId(): string {
  // Cheap UUID-ish — doesn't need to be cryptographically random, just
  // unique-per-app-install for grouping rapid cart opens together so the
  // server can dedupe noise. Module-scoped so a single app session
  // reuses the same id until the JS context is torn down.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getCartSessionId(): string {
  if (!cachedSessionId) cachedSessionId = generateSessionId();
  return cachedSessionId;
}

export function reportCartEvent(params: {
  event: CartEvent;
  merchantId: string;
  cartItemCount?: number;
  cartTotalSar?: number;
}): void {
  if (!API_URL || !params.merchantId || !supabase) return;
  // Schedule on the next tick so we never delay the caller's render.
  setTimeout(async () => {
    try {
      if (!supabase) return;
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return; // Anonymous users can't be attributed; skip.
      await fetch(`${API_URL.replace(/\/$/, '')}/api/analytics/cart-event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          event: params.event,
          merchantId: params.merchantId,
          sessionId: getCartSessionId(),
          cartItemCount: params.cartItemCount ?? null,
          cartTotalSar: params.cartTotalSar ?? null,
        }),
      });
    } catch {
      // Reporting must never escape — silent failure is by design.
    }
  }, 0);
}
