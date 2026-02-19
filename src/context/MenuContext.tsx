/**
 * MenuContext - provides products, categories, branches from Foodics API (with local fallback)
 */
import React, { createContext, ReactNode, useContext } from 'react';
import { useMenu } from '../hooks/useMenu';
import type { MenuItem } from '../hooks/useMenu';

type MenuContextType = ReturnType<typeof useMenu>;

const MenuContext = createContext<MenuContextType | undefined>(undefined);

export function MenuProvider({ children }: { children: ReactNode }) {
  const menu = useMenu();
  return <MenuContext.Provider value={menu}>{children}</MenuContext.Provider>;
}

export function useMenuContext() {
  const ctx = useContext(MenuContext);
  if (!ctx) throw new Error('useMenuContext must be used within MenuProvider');
  return ctx;
}

export type { MenuItem };
