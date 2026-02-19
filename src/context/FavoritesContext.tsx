import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';

const FAVORITES_KEY = '@als_favorites';

export type FavoritesContextType = {
  favoriteIds: Set<string>;
  isFavorite: (id: string) => boolean;
  toggleFavorite: (id: string) => void;
};

const FavoritesContext = createContext<FavoritesContextType | undefined>(undefined);

export const FavoritesProvider = ({ children }: { children: ReactNode }) => {
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    AsyncStorage.getItem(FAVORITES_KEY).then((raw) => {
      if (raw) {
        try {
          const arr = JSON.parse(raw) as string[];
          setFavoriteIds(new Set(arr));
        } catch (_) {}
      }
    });
  }, []);

  const persist = useCallback((ids: Set<string>) => {
    AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify([...ids]));
  }, []);

  const isFavorite = useCallback((id: string) => favoriteIds.has(id), [favoriteIds]);

  const toggleFavorite = useCallback((id: string) => {
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(next);
      return next;
    });
  }, [persist]);

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
