import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import i18n from '../i18n';
import { cancelAbandonedCartReminder, CART_TTL_MS, scheduleAbandonedCartReminder } from '../utils/cartNotifications';
import { useAuth } from './AuthContext';
import { useMerchant } from './MerchantContext';
import { useMerchantBranding } from './MerchantBrandingContext';

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
};

// 2. Define the Context Type (Updated with new functions)
export type CartContextType = {
  cartItems: CartItem[];
  addToCart: (product: any, quantity?: number) => void;
  removeFromCart: (product: any) => void;
  updateQuantity: (uniqueId: string, amount: number) => void;
  totalPrice: number;
  totalItems: number;
  orderType: 'delivery' | 'pickup' | 'drivethru';
  setOrderType: (type: 'delivery' | 'pickup' | 'drivethru') => void;
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
  setCartFromOrder: (order: { items: CartItem[]; orderType: 'delivery' | 'pickup' | 'drivethru'; branchId?: string; branchName?: string; deliveryAddress?: string; deliveryLat?: number; deliveryLng?: number }) => void;
};

const CartContext = createContext<CartContextType | undefined>(undefined);

type PersistedCart = {
  cartItems?: CartItem[];
  orderType?: 'delivery' | 'pickup' | 'drivethru';
  selectedBranch?: { id: string; name: string; address: string; distance?: string; oto_warehouse_id?: string; latitude?: number; longitude?: number } | null;
  deliveryAddress?: { address: string; lat?: number; lng?: number; city?: string } | null;
  updatedAt?: number;
  expiresAt?: number | null;
};

export const CartProvider = ({ children }: { children: ReactNode }) => {
  const { user, initialized } = useAuth();
  const { merchantId } = useMerchant();
  const { appName, cafeName } = useMerchantBranding();
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [orderType, setOrderTypeState] = useState<'delivery' | 'pickup' | 'drivethru'>('pickup');
  const [selectedBranch, setSelectedBranchState] = useState<{ id: string; name: string; address: string; distance?: string; oto_warehouse_id?: string; latitude?: number; longitude?: number } | null>(null);
  const [deliveryAddress, setDeliveryAddressState] = useState<{ address: string; lat?: number; lng?: number; city?: string } | null>(null);
  const [deliveryFee, setDeliveryFeeState] = useState<number>(0);
  const [deliveryOptionId, setDeliveryOptionIdState] = useState<number | null>(null);
  const [deliveryCarrierName, setDeliveryCarrierNameState] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number>(Date.now());
  // Tracks the previous (merchant, user) scope so we can clear cart
  // state when EITHER axis changes — was previously just user.
  const prevReminderKeyRef = useRef<string | null>(null);

  const uid = user?.id ?? 'guest';
  const merchantScope = merchantId || 'default';
  // Per-(merchant, user) scoped cache. Production builds have one
  // bundle per merchant so this is belt-and-suspenders against the
  // sandboxed AsyncStorage; in dev/preview where one app can switch
  // merchants via URL it actively prevents leaking cart contents.
  const CART_CACHE_KEY = `@als_cart_${merchantScope}_${uid}`;
  const CART_REMINDER_KEY = `@als_cart_reminder_${merchantScope}_${uid}`;
  const totalItems = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const totalPrice = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  const touchCart = useCallback(() => {
    setLastUpdatedAt(Date.now());
  }, []);

  // Reset cart state when EITHER user or merchant scope changes.
  // The reminder key carries both axes so it triggers on either flip.
  useEffect(() => {
    if (
      prevReminderKeyRef.current !== null &&
      prevReminderKeyRef.current !== CART_REMINDER_KEY
    ) {
      void cancelAbandonedCartReminder(prevReminderKeyRef.current);
      setCartItems([]);
      setOrderTypeState('pickup');
      setSelectedBranchState(null);
      setDeliveryAddressState(null);
      setHydrated(false);
      setLastUpdatedAt(Date.now());
    }
    prevReminderKeyRef.current = CART_REMINDER_KEY;
  }, [CART_REMINDER_KEY]);

  useEffect(() => {
    if (!initialized || hydrated) return;
    (async () => {
      try {
        let raw = await AsyncStorage.getItem(CART_CACHE_KEY);
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
        }
        if (!raw) return;
        const parsed = JSON.parse(raw) as PersistedCart;
        const now = Date.now();
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
        // Corrupted JSON or AsyncStorage error — start fresh.
      } finally {
        setHydrated(true);
      }
    })();
  }, [CART_CACHE_KEY, hydrated, initialized, uid]);

  useEffect(() => {
    if (!hydrated) return;
    const payload = JSON.stringify({
      cartItems,
      orderType,
      selectedBranch,
      deliveryAddress,
      updatedAt: lastUpdatedAt,
      expiresAt: cartItems.length > 0 ? lastUpdatedAt + CART_TTL_MS : null,
    });
    AsyncStorage.setItem(CART_CACHE_KEY, payload).catch(() => {});
  }, [hydrated, cartItems, orderType, selectedBranch, deliveryAddress, CART_CACHE_KEY, lastUpdatedAt]);

  useEffect(() => {
    if (!hydrated || !initialized) return;
    if (cartItems.length === 0) {
      void cancelAbandonedCartReminder(CART_REMINDER_KEY);
    }
  }, [hydrated, initialized, cartItems.length, CART_REMINDER_KEY]);

  useEffect(() => {
    if (!hydrated || !initialized) return;

    const subscription = AppState.addEventListener('change', (state) => {
      const expiresAt = lastUpdatedAt + CART_TTL_MS;

      if (state === 'active') {
        void cancelAbandonedCartReminder(CART_REMINDER_KEY);
        if (cartItems.length > 0 && expiresAt <= Date.now()) {
          setCartItems([]);
        }
        return;
      }

      if (state !== 'background') return;

      if (cartItems.length === 0 || expiresAt <= Date.now()) {
        void cancelAbandonedCartReminder(CART_REMINDER_KEY);
        return;
      }

      const brandName = (appName?.trim() || cafeName?.trim() || '').trim();
      void scheduleAbandonedCartReminder({
        reminderKey: CART_REMINDER_KEY,
        brandName,
        itemCount: totalItems,
        isArabic: i18n.language === 'ar',
      });
    });

    return () => subscription.remove();
  }, [hydrated, initialized, cartItems.length, totalItems, lastUpdatedAt, CART_REMINDER_KEY, appName, cafeName]);

  const setOrderType = useCallback((type: 'delivery' | 'pickup' | 'drivethru') => {
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
    setCartItems((prevItems) => 
      prevItems.map((item) => 
        item.uniqueId === uniqueId 
          ? { ...item, quantity: item.quantity + amount } 
          : item
      ).filter(item => item.quantity > 0)
    );
  };

  const removeFromCart = (product: any) => {
    touchCart();
    setCartItems((prevItems) => {
      const uniqueId = product.uniqueId;
      return prevItems.filter((item) => item.uniqueId !== uniqueId);
    });
  };

  const clearCart = () => {
    touchCart();
    setCartItems([]);
  };

  const setCartFromOrder = (order: {
    items: CartItem[];
    orderType: 'delivery' | 'pickup' | 'drivethru';
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