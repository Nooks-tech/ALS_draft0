import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useMerchant } from './MerchantContext';

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
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);

  // Per-merchant namespaced cache. Saved addresses are personal data
  // and especially important to scope per-merchant — a customer who
  // ordered from Merchant A shouldn't see those same addresses
  // pre-filled when they install Merchant B's app on the same device.
  // (Production builds are per-bundle so AsyncStorage is sandboxed
  // anyway, but this keeps dev/preview safe and future-proofs against
  // a multi-merchant single-app deployment.)
  const addressesKey = `@als_saved_addresses_${merchantId || 'default'}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let raw = await AsyncStorage.getItem(addressesKey);
        // One-time migration of pre-namespacing data.
        if (!raw && merchantId) {
          const legacy = await AsyncStorage.getItem(LEGACY_SAVED_ADDRESSES_KEY);
          if (legacy) {
            await AsyncStorage.setItem(addressesKey, legacy);
            await AsyncStorage.removeItem(LEGACY_SAVED_ADDRESSES_KEY);
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
  }, [addressesKey, merchantId]);

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
