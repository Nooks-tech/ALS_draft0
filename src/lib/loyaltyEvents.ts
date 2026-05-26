/**
 * Pub-sub for loyalty balance changes. Used so screens that show the
 * customer's points balance (rewards.tsx, loyalty-modal.tsx, offers.tsx,
 * menu tab embedded card) refetch immediately after a cart-removal
 * triggers a points refund — instead of waiting for the next focus.
 *
 * Lives in module scope, not a React context, because the cart context
 * (publisher) and loyalty screens (subscribers) are siblings and would
 * otherwise need to plumb a callback through a common ancestor.
 *
 * Browser/Node-friendly — no React Native specific APIs.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export const loyaltyEvents = {
  /** Subscribe; returns an unsubscribe function for useEffect cleanup. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Fire the event. Errors in listeners are swallowed — one bad
   *  subscriber must not break the others. */
  emit(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[loyaltyEvents] listener threw:', err);
      }
    }
  },
};
