import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const SAVED_ADDRESSES_KEY = '@als_saved_addresses';

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

const persist = async (addresses: SavedAddress[]) => {
  await AsyncStorage.setItem(SAVED_ADDRESSES_KEY, JSON.stringify(addresses));
};

export const SavedAddressesProvider = ({ children }: { children: ReactNode }) => {
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(SAVED_ADDRESSES_KEY).then((raw) => {
      if (raw) {
        try {
          setAddresses(JSON.parse(raw));
        } catch (_) {}
      }
    });
  }, []);

  const addAddress = useCallback((addr: Omit<SavedAddress, 'id'>) => {
    const newAddr: SavedAddress = {
      ...addr,
      id: `addr-${Date.now()}`,
    };
    setAddresses((prev) => {
      const next = prev.map((a) => ({ ...a, isDefault: addr.isDefault ? false : a.isDefault }));
      const list = [...next, { ...newAddr, isDefault: addr.isDefault || prev.length === 0 }];
      persist(list);
      return list;
    });
  }, []);

  const updateAddress = useCallback((id: string, data: Partial<SavedAddress>) => {
    setAddresses((prev) => {
      const next = prev.map((a) => (a.id === id ? { ...a, ...data } : a));
      persist(next);
      return next;
    });
  }, []);

  const removeAddress = useCallback((id: string) => {
    setAddresses((prev) => {
      const next = prev.filter((a) => a.id !== id);
      persist(next);
      return next;
    });
  }, []);

  const setDefault = useCallback((id: string) => {
    setAddresses((prev) => {
      const next = prev.map((a) => ({ ...a, isDefault: a.id === id }));
      persist(next);
      return next;
    });
  }, []);

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
