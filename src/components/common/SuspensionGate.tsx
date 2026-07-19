/**
 * App-wide suspension gate. Replaces the entire navigator stack with
 * a "store unavailable" blocker when subscriptionState is 'suspended'.
 *
 * This is NOT the billing-grace-period path: a merchant that has
 * lapsed past their grace period gets subscriptionState
 * 'billing_closed' from the branding endpoint and keeps the
 * browsable storefront — operations forces every branch closed with
 * reason 'billing' instead. 'suspended' only fires for
 * never-activated/hard-blocked merchants, and for the branding
 * fail-closed path (fetch failed + cache more than 24h stale).
 *
 * Lives at the root layout (above the Stack), so it gates every
 * route: tabs, modals (checkout, payment-modal, wallet-modal,
 * add-card-modal, etc.), and the order-confirmed screen. A purely
 * tab-level gate would leave modal routes (which sit at root level
 * in expo-router) reachable via router.push() — that was the
 * leak we patched.
 *
 * `subscriptionState` comes from the branding context which fetches
 * from nooksweb's branding endpoint and refreshes on AppState
 * 'active'. While the fetch is in-flight, the children render
 * normally (false-negative is OK; suspension flips back to a
 * blocker on the next branding response).
 */
import { ReactNode } from 'react';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';
import StoreUnavailableBlocker from './StoreUnavailableBlocker';

export default function SuspensionGate({ children }: { children: ReactNode }) {
  const { subscriptionState } = useMerchantBranding();
  if (subscriptionState === 'suspended') {
    return <StoreUnavailableBlocker />;
  }
  return <>{children}</>;
}
