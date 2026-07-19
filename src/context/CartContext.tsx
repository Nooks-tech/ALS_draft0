import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { CART_TTL_MS } from '../utils/cartNotifications';
import {
  deleteServerCart,
  fetchServerCart,
  saveServerCart,
  type ServerCartItem,
} from '../api/cart';
import { loyaltyApi } from '../api/loyalty';
import { loyaltyEvents } from '../lib/loyaltyEvents';
import { useAuth } from './AuthContext';
import { useMerchant } from './MerchantContext';

// 1. Define the item structure (Restored from your old code)
export type CartItem = {
  id: string;
  name: string;
  /** Display unit price — base + selected modifier surcharges. */
  price: number;
  /**
   * Product base price with NO modifier surcharges mixed in. Relayed to
   * Foodics as `unit_price` so modifiers, which are sent as a separate
   * `options[]` array with their own `unit_price`, are not double-counted.
   */
  basePrice?: number;
  quantity: number;
  image: string;
  customizations?: { [key: string]: any };
  uniqueId: string;
  /**
   * Set when this cart line is a stamp-milestone reward (free item).
   * The /rewards screen and the checkout milestone toggle both write
   * these reward items into the cart so the cart screen shows them
   * naturally as 0-priced lines. Checkout derives the selected
   * milestone IDs by collecting unique values of this field across
   * cart items.
   */
  rewardMilestoneId?: string;
  /**
   * Points-redemption transaction id returned by /redeem-milestone.
   * Used to call /unredeem-milestone (refund) when the customer
   * removes the reward from their cart before checkout. The server
   * is idempotent on this id so multiple calls are safe.
   */
  rewardRedemptionId?: string;
  /**
   * Original menu price of a reward item. Customer sees 0 SAR in the
   * cart, but the Foodics relay sends the item at full price with a
   * matching per-item discount so the merchant's reports show real
   * item revenue + a clear "stamp reward" discount line. Undefined
   * for non-reward items.
   */
  rewardOriginalPriceSar?: number;
};

// 2. Define the Context Type (Updated with new functions)
export type CartContextType = {
  cartItems: CartItem[];
  addToCart: (product: any, quantity?: number) => void;
  removeFromCart: (product: any) => void;
  updateQuantity: (uniqueId: string, amount: number) => void;
  totalPrice: number;
  totalItems: number;
  orderType: 'delivery' | 'pickup' | 'drivethru' | 'dine_in';
  setOrderType: (type: 'delivery' | 'pickup' | 'drivethru' | 'dine_in') => void;
  selectedBranch: any;
  setSelectedBranch: (branch: any) => void;
  deliveryAddress: { address: string; lat?: number; lng?: number; city?: string } | null;
  setDeliveryAddress: (addr: { address: string; lat?: number; lng?: number; city?: string } | null) => void;
  deliveryFee: number;
  setDeliveryFee: (fee: number) => void;
  deliveryOptionId: number | null;
  setDeliveryOptionId: (id: number | null) => void;
  deliveryCarrierName: string | null;
  setDeliveryCarrierName: (name: string | null) => void;
  clearCart: () => void;
  /** Re-order: set cart and order type from a placed order (e.g. for Re-order button). */
  setCartFromOrder: (order: { items: CartItem[]; orderType: 'delivery' | 'pickup' | 'drivethru' | 'dine_in'; branchId?: string; branchName?: string; deliveryAddress?: string; deliveryLat?: number; deliveryLng?: number }) => void;
};

const CartContext = createContext<CartContextType | undefined>(undefined);

type PersistedCart = {
  cartItems?: CartItem[];
  orderType?: 'delivery' | 'pickup' | 'drivethru' | 'dine_in';
  selectedBranch?: { id: string; name: string; address: string; distance?: string; oto_warehouse_id?: string; latitude?: number; longitude?: number } | null;
  deliveryAddress?: { address: string; lat?: number; lng?: number; city?: string } | null;
  updatedAt?: number;
  expiresAt?: number | null;
};

import { useQrLanding } from './QrLandingContext';

export const CartProvider = ({ children }: { children: ReactNode }) => {
  const { user, initialized } = useAuth();
  const { merchantId } = useMerchant();
  const { landing } = useQrLanding();
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [orderType, setOrderTypeState] = useState<'delivery' | 'pickup' | 'drivethru' | 'dine_in'>('pickup');
  const [selectedBranch, setSelectedBranchState] = useState<{ id: string; name: string; address: string; distance?: string; oto_warehouse_id?: string; latitude?: number; longitude?: number } | null>(null);
  const [deliveryAddress, setDeliveryAddressState] = useState<{ address: string; lat?: number; lng?: number; city?: string } | null>(null);
  const [deliveryFee, setDeliveryFeeState] = useState<number>(0);
  const [deliveryOptionId, setDeliveryOptionIdState] = useState<number | null>(null);
  const [deliveryCarrierName, setDeliveryCarrierNameState] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number>(Date.now());
  // Tracks the previous (merchant, user) scope so we can clear cart
  // state when EITHER axis changes.
  const prevScopeRef = useRef<string | null>(null);
  // Which scope the current in-memory cart was hydrated FOR. The
  // persistence + server-sync effects refuse to write unless this
  // matches the render's scope. Without it, the one render where the
  // scope (and thus CART_CACHE_KEY) has already switched but the
  // reset effect's setState hasn't applied yet would write the OLD
  // user's items under the NEW user's key — the cross-account cart
  // leak (A logs out, B signs in, B sees A's basket).
  const hydratedScopeRef = useRef<string | null>(null);
  // Phase D: debounce server sync writes so a flurry of "+ -" taps
  // collapses into one PUT.
  const serverSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const uid = user?.id ?? 'guest';
  const merchantScope = merchantId || 'default';
  // Per-(merchant, user) scoped cache. Production builds have one
  // bundle per merchant so this is belt-and-suspenders against the
  // sandboxed AsyncStorage; in dev/preview where one app can switch
  // merchants via URL it actively prevents leaking cart contents.
  const CART_CACHE_KEY = `@als_cart_${merchantScope}_${uid}`;
  const SCOPE_KEY = `${merchantScope}:${uid}`;
  const totalItems = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const totalPrice = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  const touchCart = useCallback(() => {
    setLastUpdatedAt(Date.now());
  }, []);

  // Reset cart state when EITHER user or merchant scope changes.
  useEffect(() => {
    if (
      prevScopeRef.current !== null &&
      prevScopeRef.current !== SCOPE_KEY
    ) {
      hydratedScopeRef.current = null;
      setCartItems([]);
      setOrderTypeState('pickup');
      setSelectedBranchState(null);
      setDeliveryAddressState(null);
      setDeliveryFeeState(0);
      setDeliveryOptionIdState(null);
      setDeliveryCarrierNameState(null);
      setHydrated(false);
      setLastUpdatedAt(Date.now());
    }
    prevScopeRef.current = SCOPE_KEY;
  }, [SCOPE_KEY]);

  useEffect(() => {
    if (!initialized || hydrated) return;
    // Cancellation guard: if the (merchant, user) scope flips while a
    // hydration is in flight (logout mid-fetch, merchant id resolving
    // at boot), the stale run must not seed the NEW scope's state with
    // the OLD scope's server/local cart.
    let cancelled = false;
    (async () => {
      try {
        // Phase D: try the server first (source of truth across devices
        // and reinstalls). Fall back to the AsyncStorage cache when
        // offline or the customer isn't authenticated yet.
        //
        // 2026-05-24: distinguish three server responses:
        //   - remote === null         → network error / unauth — fall
        //                               through to local cache (offline
        //                               resilience).
        //   - remote.items.length>0   → server has a saved cart — seed
        //                               from it.
        //   - remote.items.length==0  → server EXPLICITLY says empty
        //                               cart. Either the customer just
        //                               committed an order, or the
        //                               abandonment cron deleted the
        //                               row 45 min+ after no activity.
        //                               In that case we must clear any
        //                               stale local cache instead of
        //                               re-hydrating the user's view
        //                               with items that no longer
        //                               exist as a saved cart — the
        //                               previous fallback re-synced
        //                               them back to the server and
        //                               looped the abandon/notify
        //                               cycle. Founder spec 2026-05-24:
        //                               "make sure the items in the
        //                               cart actually get deleted for
        //                               that user".
        let seeded = false;
        let serverSaysEmpty = false;
        if (uid !== 'guest' && merchantId) {
          const remote = await fetchServerCart(merchantId);
          if (cancelled) return;
          if (remote) {
            if (Array.isArray(remote.items) && remote.items.length > 0) {
              setCartItems(remote.items as CartItem[]);
              if (remote.order_type === 'delivery' || remote.order_type === 'pickup' || remote.order_type === 'drivethru') {
                setOrderTypeState(remote.order_type);
              }
              setLastUpdatedAt(remote.updated_at ? new Date(remote.updated_at).getTime() : Date.now());
              seeded = true;
            } else {
              serverSaysEmpty = true;
            }
          }
        }

        let raw = await AsyncStorage.getItem(CART_CACHE_KEY);
        if (cancelled) return;
        // One-time migration of legacy non-namespaced cart data so
        // existing customers don't lose their basket on the OTA
        // update that introduced merchant scoping.
        if (!raw && uid !== 'guest') {
          const legacy = await AsyncStorage.getItem(`@als_cart_${uid}`);
          if (legacy) {
            await AsyncStorage.setItem(CART_CACHE_KEY, legacy);
            await AsyncStorage.removeItem(`@als_cart_${uid}`);
            raw = legacy;
          }
          if (cancelled) return;
        }
        if (!raw || seeded) return;
        const parsed = JSON.parse(raw) as PersistedCart;
        const now = Date.now();

        // When the server is authoritative-empty and the local cache
        // hasn't been touched within the abandonment window, the cart
        // was almost certainly removed by the abandonment cron — clear
        // local. We use 30 min as the threshold (= the grace window
        // BETWEEN notification and abandonment); anything more recent
        // and the customer probably just made a local change that
        // hasn't synced. Offline edits are protected because remote
        // === null falls through this branch entirely.
        const CART_ABANDON_GRACE_MS = 30 * 60 * 1000;
        if (
          serverSaysEmpty &&
          typeof parsed.updatedAt === 'number' &&
          now - parsed.updatedAt >= CART_ABANDON_GRACE_MS
        ) {
          await AsyncStorage.removeItem(CART_CACHE_KEY);
          return;
        }
        if (cancelled) return;

        const expiresAt =
          typeof parsed.expiresAt === 'number'
            ? parsed.expiresAt
            : typeof parsed.updatedAt === 'number'
              ? parsed.updatedAt + CART_TTL_MS
              : null;

        if (expiresAt != null && expiresAt <= now) {
          await AsyncStorage.removeItem(CART_CACHE_KEY);
          return;
        }

        if (Array.isArray(parsed.cartItems)) setCartItems(parsed.cartItems);
        if (parsed.orderType === 'delivery' || parsed.orderType === 'pickup') setOrderTypeState(parsed.orderType);
        if (parsed.selectedBranch) setSelectedBranchState(parsed.selectedBranch);
        if (parsed.deliveryAddress) setDeliveryAddressState(parsed.deliveryAddress);
        setLastUpdatedAt(typeof parsed.updatedAt === 'number' ? parsed.updatedAt : now);
      } catch {
        // Corrupted JSON, AsyncStorage error, or offline — start fresh.
      } finally {
        if (!cancelled) {
          // Stamp WHICH scope this hydration was for — the write
          // effects below key off it, not just the boolean.
          hydratedScopeRef.current = SCOPE_KEY;
          setHydrated(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [CART_CACHE_KEY, SCOPE_KEY, hydrated, initialized, uid, merchantId]);

  // QR landing: when the entry URL carries an order_type override,
  // apply it AFTER cache hydration so the QR's intent wins over a
  // stale persisted "pickup". Branch selection lands at commit time
  // via the qrCodeId → server-side branch_id resolution (no
  // optimistic UI for branch here — the QR row is server truth).
  useEffect(() => {
    if (!hydrated || !landing.orderType) return;
    setOrderTypeState(landing.orderType);
  }, [hydrated, landing.orderType]);

  useEffect(() => {
    // Scope-accurate write guard (not just the hydrated boolean): on
    // the render where the scope has switched but state is still the
    // previous user's, hydratedScopeRef holds the OLD scope (or null)
    // — never write that cart under the NEW scope's key.
    if (!hydrated || hydratedScopeRef.current !== SCOPE_KEY) return;
    const payload = JSON.stringify({
      cartItems,
      orderType,
      selectedBranch,
      deliveryAddress,
      updatedAt: lastUpdatedAt,
      expiresAt: cartItems.length > 0 ? lastUpdatedAt + CART_TTL_MS : null,
    });
    AsyncStorage.setItem(CART_CACHE_KEY, payload).catch(() => {});
  }, [hydrated, cartItems, orderType, selectedBranch, deliveryAddress, CART_CACHE_KEY, SCOPE_KEY, lastUpdatedAt]);

  // Phase D: debounced server-side sync. Every cart change schedules a
  // PUT 300ms later; back-to-back changes collapse into one request.
  // When the cart goes empty we DELETE so the abandonment cron has
  // nothing to chase. Offline failures are silently ignored — the
  // AsyncStorage mirror above keeps the UI responsive.
  useEffect(() => {
    if (!hydrated || !initialized) return;
    if (!merchantId || uid === 'guest') return;
    // Same scope-accurate guard as the AsyncStorage mirror above —
    // without it, the transition render would schedule a PUT of the
    // previous user's items under the NEW user's session token.
    if (hydratedScopeRef.current !== SCOPE_KEY) return;
    if (serverSyncTimerRef.current) {
      clearTimeout(serverSyncTimerRef.current);
    }
    serverSyncTimerRef.current = setTimeout(() => {
      if (cartItems.length === 0) {
        void deleteServerCart(merchantId);
        return;
      }
      void saveServerCart(merchantId, {
        items: cartItems as ServerCartItem[],
        subtotal_sar: Number(totalPrice.toFixed(2)),
        branch_id: selectedBranch?.id ?? null,
        order_type: orderType,
      });
    }, 300);
    return () => {
      if (serverSyncTimerRef.current) {
        clearTimeout(serverSyncTimerRef.current);
      }
    };
  }, [
    hydrated,
    initialized,
    merchantId,
    uid,
    cartItems,
    totalPrice,
    selectedBranch?.id,
    orderType,
  ]);

  const setOrderType = useCallback((type: 'delivery' | 'pickup' | 'drivethru' | 'dine_in') => {
    setOrderTypeState(type);
    if (type === 'pickup') {
      setDeliveryFeeState(0);
      setDeliveryOptionIdState(null);
      setDeliveryCarrierNameState(null);
    }
    touchCart();
  }, [touchCart]);

  const setDeliveryFee = useCallback((fee: number) => { setDeliveryFeeState(fee); touchCart(); }, [touchCart]);
  const setDeliveryOptionId = useCallback((id: number | null) => { setDeliveryOptionIdState(id); touchCart(); }, [touchCart]);
  const setDeliveryCarrierName = useCallback((name: string | null) => { setDeliveryCarrierNameState(name); touchCart(); }, [touchCart]);

  const setSelectedBranch = useCallback((branch: any) => {
    setSelectedBranchState(branch);
    touchCart();
  }, [touchCart]);

  const setDeliveryAddress = useCallback((addr: { address: string; lat?: number; lng?: number; city?: string } | null) => {
    setDeliveryAddressState(addr);
    touchCart();
  }, [touchCart]);

  // RESTORED: Your smart Unique ID generator
  const generateUniqueId = (product: any) => {
    if (!product.customizations || Object.keys(product.customizations).length === 0) return product.id;
    const optionsString = Object.entries(product.customizations)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB)) 
      .map(([_, val]: any) => val.name)
      .join('-');
    return `${product.id}-${optionsString}`;
  };

  const addToCart = (product: any, quantity: number = 1) => {
    const qty = Math.max(1, Math.floor(quantity));
    touchCart();
    setCartItems((prevItems) => {
      // Respect a caller-supplied uniqueId when present. Reward items
      // from the /rewards screen pass uniqueId='reward-<milestoneId>-
      // <foodicsId>'. Without this, the auto-generated id would override
      // the prefix and the server's reward-item floor exemption would
      // miss it, rejecting the 0-priced line as "tampered".
      const uniqueId = typeof product?.uniqueId === 'string' && product.uniqueId
        ? product.uniqueId
        : generateUniqueId(product);
      const existingItem = prevItems.find((item) => item.uniqueId === uniqueId);

      if (existingItem) {
        return prevItems.map((item) =>
          item.uniqueId === uniqueId
            ? { ...item, quantity: item.quantity + qty }
            : item
        );
      } else {
        return [...prevItems, { ...product, uniqueId, quantity: qty }];
      }
    });
  };

  // ADDED: Specifically for the + and - buttons in the Cart Screen
  const updateQuantity = (uniqueId: string, amount: number) => {
    touchCart();
    setCartItems((prevItems) => {
      const updated = prevItems.map((item) =>
        item.uniqueId === uniqueId
          ? { ...item, quantity: item.quantity + amount }
          : item,
      );
      // Any item driven to quantity ≤ 0 is removed. If a reward line
      // gets removed this way, refund the redemption AND cascade-remove
      // its sibling lines (same redemption can span multiple products).
      const removedItems = updated.filter((it) => it.quantity <= 0);
      const refundRids = new Set<string>();
      for (const it of removedItems) {
        if (it.rewardRedemptionId) refundRids.add(it.rewardRedemptionId);
      }
      let next = updated.filter((it) => it.quantity > 0);
      if (refundRids.size > 0) {
        const linked = next.filter((it) => it.rewardRedemptionId && refundRids.has(it.rewardRedemptionId));
        if (linked.length > 0) next = next.filter((it) => !it.rewardRedemptionId || !refundRids.has(it.rewardRedemptionId));
        refundRedemptionsFor([...removedItems, ...linked]);
      }
      return next;
    });
  };

  /**
   * Fire-and-forget refund for a removed reward. Called when the
   * customer takes a reward back out of the cart before checkout.
   * Server-side idempotent on redemptionId, so we don't need to
   * track which ones we've already refunded locally.
   */
  const refundRedemptionsFor = useCallback(
    (items: CartItem[]) => {
      if (!user?.id || !merchantId) return;
      const redemptionIds = Array.from(
        new Set(items.map((it) => it.rewardRedemptionId).filter((id): id is string => Boolean(id))),
      );
      for (const rid of redemptionIds) {
        loyaltyApi
          .unredeemMilestone(merchantId, user.id, rid)
          .then(() => {
            // Tell every subscribed loyalty screen to refetch — they
            // re-pull /balance and show the refunded points instantly.
            loyaltyEvents.emit();
          })
          .catch((err) => {
            console.warn('[cart] unredeem-milestone failed for', rid, err);
          });
      }
    },
    [user?.id, merchantId],
  );

  const removeFromCart = (product: any) => {
    touchCart();
    setCartItems((prevItems) => {
      const uniqueId = product.uniqueId;
      const removed = prevItems.find((item) => item.uniqueId === uniqueId);
      // If the removed line was part of a reward redemption, ALSO remove
      // any sibling reward lines that share the same redemptionId — a
      // single redemption can fan out to multiple Foodics products, and
      // the customer's intent in removing one is to back out of the
      // whole reward (otherwise we'd refund the points but leave them
      // with a partial freebie still in the cart).
      const targetRid = removed?.rewardRedemptionId;
      let next: CartItem[];
      if (targetRid) {
        const linked = prevItems.filter((item) => item.rewardRedemptionId === targetRid);
        next = prevItems.filter((item) => item.rewardRedemptionId !== targetRid);
        refundRedemptionsFor(linked);
      } else {
        next = prevItems.filter((item) => item.uniqueId !== uniqueId);
      }
      return next;
    });
  };

  const clearCart = () => {
    touchCart();
    setCartItems((prevItems) => {
      // Refund any reward redemptions before clearing — handles the
      // "user pressed Clear Cart" UX path without leaking points.
      refundRedemptionsFor(prevItems);
      return [];
    });
  };

  const setCartFromOrder = (order: {
    items: CartItem[];
    orderType: 'delivery' | 'pickup' | 'drivethru' | 'dine_in';
    branchId?: string;
    branchName?: string;
    deliveryAddress?: string;
    deliveryLat?: number;
    deliveryLng?: number;
  }) => {
    touchCart();
    setCartItems(order.items);
    setOrderTypeState(order.orderType);
    if (order.branchId != null && order.branchName != null) {
      setSelectedBranchState({ id: order.branchId, name: order.branchName, address: '' });
    }
    if (order.orderType === 'delivery' && order.deliveryAddress) {
      setDeliveryAddressState({
        address: order.deliveryAddress,
        lat: order.deliveryLat,
        lng: order.deliveryLng,
      });
    } else {
      setDeliveryAddressState(null);
    }
  };

  return (
    <CartContext.Provider
      value={{
        cartItems,
        addToCart,
        removeFromCart,
        updateQuantity,
        totalPrice,
        totalItems,
        orderType,
        setOrderType,
        selectedBranch,
        setSelectedBranch,
        deliveryAddress,
        setDeliveryAddress,
        deliveryFee,
        setDeliveryFee,
        deliveryOptionId,
        setDeliveryOptionId,
        deliveryCarrierName,
        setDeliveryCarrierName,
        clearCart,
        setCartFromOrder,
      }}
    >
      {children}
    </CartContext.Provider>
  );
};

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
};