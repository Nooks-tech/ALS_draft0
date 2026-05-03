import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { useMerchant } from './MerchantContext';

const LEGACY_FAVORITES_KEY = '@als_favorites';

export type FavoritesContextType = {
  favoriteIds: Set<string>;
  isFavorite: (id: string) => boolean;
  toggleFavorite: (id: string) => void;
};

const FavoritesContext = createContext<FavoritesContextType | undefined>(undefined);

export const FavoritesProvider = ({ children }: { children: ReactNode }) => {
  const { merchantId } = useMerchant();
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());

  // Per-merchant namespaced cache. Each native build has a fixed
  // merchantId baked in, so on production this never collides anyway —
  // but in dev/preview builds (where MerchantContext can swap merchant
  // mid-session via URL or auto-discover) the namespace prevents one
  // merchant's favorite product IDs from leaking into another
  // merchant's bucket.
  const favoritesKey = `@als_favorites_${merchantId || 'default'}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let raw = await AsyncStorage.getItem(favoritesKey);
        // One-time migration: customers on the previous build had
        // their favorites under the un-namespaced LEGACY key. Move
        // them into the current merchant's bucket so the OTA update
        // doesn't surface as data loss.
        if (!raw && merchantId) {
          const legacy = await AsyncStorage.getItem(LEGACY_FAVORITES_KEY);
          if (legacy) {
            await AsyncStorage.setItem(favoritesKey, legacy);
            await AsyncStorage.removeItem(LEGACY_FAVORITES_KEY);
            raw = legacy;
          }
        }
        if (cancelled) return;
        if (raw) {
          const arr = JSON.parse(raw) as string[];
          setFavoriteIds(new Set(arr));
        } else {
          setFavoriteIds(new Set());
        }
      } catch {
        // Corrupted JSON or AsyncStorage error — start fresh.
        if (!cancelled) setFavoriteIds(new Set());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [favoritesKey, merchantId]);

  const persist = useCallback(
    (ids: Set<string>) => {
      AsyncStorage.setItem(favoritesKey, JSON.stringify([...ids])).catch(() => {});
    },
    [favoritesKey],
  );

  const isFavorite = useCallback((id: string) => favoriteIds.has(id), [favoriteIds]);

  const toggleFavorite = useCallback(
    (id: string) => {
      setFavoriteIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  return (
    <FavoritesContext.Provider value={{ favoriteIds, isFavorite, toggleFavorite }}>
      {children}
    </FavoritesContext.Provider>
  );
};

export const useFavorites = () => {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error('useFavorites must be used within FavoritesProvider');
  return ctx;
};
