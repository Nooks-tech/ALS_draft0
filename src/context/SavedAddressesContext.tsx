import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useMerchant } from './MerchantContext';
import { useAuth } from './AuthContext';

const LEGACY_SAVED_ADDRESSES_KEY = '@als_saved_addresses';

export type SavedAddress = {
  id: string;
  label: 'Home' | 'Work' | 'Other';
  customLabel?: string; // when label is 'Other'
  address: string;
  lat?: number;
  lng?: number;
  city?: string; // for OTO delivery options (branch city vs customer city)
  isDefault: boolean;
};

export type SavedAddressesContextType = {
  addresses: SavedAddress[];
  addAddress: (addr: Omit<SavedAddress, 'id'>) => void;
  updateAddress: (id: string, data: Partial<SavedAddress>) => void;
  removeAddress: (id: string) => void;
  setDefault: (id: string) => void;
};

const SavedAddressesContext = createContext<SavedAddressesContextType | undefined>(undefined);

export const SavedAddressesProvider = ({ children }: { children: ReactNode }) => {
  const { merchantId } = useMerchant();
  const { user, initialized } = useAuth();
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);

  // Per-(merchant, user) namespaced cache. Saved addresses are personal
  // data: the merchant axis keeps dev/preview builds (which can swap
  // merchants mid-session) from cross-pollinating, and the USER axis
  // keeps one customer's addresses from surfacing after an account
  // switch on the same phone. The key change on user switch also
  // re-runs the hydration effect below, which is what evicts the
  // previous user's addresses from memory — without the user axis,
  // logout/login never re-hydrated and account B kept seeing account
  // A's addresses (same family as the cross-account cart leak).
  const uid = user?.id ?? 'guest';
  const merchantScope = merchantId || 'default';
  const addressesKey = `@als_saved_addresses_${merchantScope}_${uid}`;
  // Pre-user-namespacing key (was per-merchant only) — migrated below.
  const merchantLegacyKey = `@als_saved_addresses_${merchantScope}`;

  // Evict the previous scope's addresses from memory the moment the
  // scope changes — the async hydration below takes at least one
  // storage round-trip, and a mounted consumer (address modal,
  // order-type sheet) must never keep showing the previous user's
  // addresses during that window.
  const prevScopeRef = useRef<string | null>(null);
  useEffect(() => {
    const scope = `${merchantScope}:${uid}`;
    if (prevScopeRef.current !== null && prevScopeRef.current !== scope) {
      setAddresses([]);
    }
    prevScopeRef.current = scope;
  }, [merchantScope, uid]);

  useEffect(() => {
    if (!initialized) return;
    let cancelled = false;
    (async () => {
      try {
        let raw = await AsyncStorage.getItem(addressesKey);
        if (cancelled) return;
        // One-time migrations, signed-in users only (a guest session
        // must not claim — and thereby strip — the device's addresses
        // before the owner signs back in): first from the per-merchant
        // key this cache used before user-namespacing, then from the
        // original un-namespaced key. Only the key actually consumed
        // is deleted, and never after this run has been superseded by
        // a newer scope (the cancelled checks) — a stale run writing
        // or deleting here is exactly how data would cross accounts.
        if (!raw && uid !== 'guest') {
          let legacy = await AsyncStorage.getItem(merchantLegacyKey);
          let legacySource = merchantLegacyKey;
          if (!legacy) {
            legacy = await AsyncStorage.getItem(LEGACY_SAVED_ADDRESSES_KEY);
            legacySource = LEGACY_SAVED_ADDRESSES_KEY;
          }
          if (cancelled) return;
          if (legacy) {
            await AsyncStorage.setItem(addressesKey, legacy);
            await AsyncStorage.removeItem(legacySource);
            raw = legacy;
          }
        }
        if (cancelled) return;
        if (raw) {
          setAddresses(JSON.parse(raw));
        } else {
          setAddresses([]);
        }
      } catch {
        if (!cancelled) setAddresses([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addressesKey, merchantLegacyKey, initialized, merchantScope, uid]);

  const persist = useCallback(
    async (next: SavedAddress[]) => {
      try {
        await AsyncStorage.setItem(addressesKey, JSON.stringify(next));
      } catch {}
    },
    [addressesKey],
  );

  const addAddress = useCallback(
    (addr: Omit<SavedAddress, 'id'>) => {
      const newAddr: SavedAddress = {
        ...addr,
        id: `addr-${Date.now()}`,
      };
      setAddresses((prev) => {
        const next = prev.map((a) => ({ ...a, isDefault: addr.isDefault ? false : a.isDefault }));
        const list = [...next, { ...newAddr, isDefault: addr.isDefault ?? (prev.length === 0) }];
        void persist(list);
        return list;
      });
    },
    [persist],
  );

  const updateAddress = useCallback(
    (id: string, data: Partial<SavedAddress>) => {
      setAddresses((prev) => {
        const next = prev.map((a) => (a.id === id ? { ...a, ...data } : a));
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const removeAddress = useCallback(
    (id: string) => {
      setAddresses((prev) => {
        const next = prev.filter((a) => a.id !== id);
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const setDefault = useCallback(
    (id: string) => {
      setAddresses((prev) => {
        const next = prev.map((a) => ({ ...a, isDefault: a.id === id }));
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const addressesSorted = useMemo(
    () => [...addresses].sort((a, b) => (a.isDefault ? 0 : 1) - (b.isDefault ? 0 : 1)),
    [addresses],
  );

  return (
    <SavedAddressesContext.Provider value={{ addresses: addressesSorted, addAddress, updateAddress, removeAddress, setDefault }}>
      {children}
    </SavedAddressesContext.Provider>
  );
};

export const useSavedAddresses = () => {
  const ctx = useContext(SavedAddressesContext);
  if (!ctx) throw new Error('useSavedAddresses must be used within SavedAddressesProvider');
  return ctx;
};
