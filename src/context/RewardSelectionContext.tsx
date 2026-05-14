/**
 * Shared state for selected stamp-milestone redemptions across screens.
 *
 * Why a dedicated context: the /rewards screen and the /checkout
 * screen both need to know which milestones the customer wants to
 * redeem on their next order. Without shared state, a redemption
 * picked on /rewards would be invisible at checkout, and vice versa.
 *
 * State is scoped per (merchantId, customerId) and persisted to
 * AsyncStorage so navigating away and back doesn't lose selections.
 * Cleared automatically when:
 *   - the order is committed (clearMilestones() called by checkout)
 *   - the merchant or user changes
 *
 * Reward items are NOT stored in the regular cart — they're computed
 * by checkout from this set + the loyalty balance at commit time.
 * This keeps the cart's pricing math simple (no need for the cart
 * screen to know about loyalty) and avoids "remove from cart" UX
 * needing to call back into milestone-clear logic.
 */
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './AuthContext';
import { useMerchant } from './MerchantContext';

type RewardSelectionContextType = {
  selectedMilestoneIds: Set<string>;
  toggleMilestone: (id: string) => void;
  addMilestone: (id: string) => void;
  removeMilestone: (id: string) => void;
  clearMilestones: () => void;
  isMilestoneSelected: (id: string) => boolean;
};

const RewardSelectionContext = createContext<RewardSelectionContextType | undefined>(undefined);

function storageKey(merchantId: string | null | undefined, customerId: string | null | undefined): string | null {
  if (!merchantId || !customerId) return null;
  return `@als_selected_milestones::${merchantId}::${customerId}`;
}

export function RewardSelectionProvider({ children }: { children: ReactNode }) {
  const { merchantId } = useMerchant();
  const { user } = useAuth();
  const customerId = user?.id ?? null;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Hydrate from AsyncStorage on (merchant, user) change. Also clears
  // the set when scope changes so one customer's selections don't
  // leak to the next.
  useEffect(() => {
    const key = storageKey(merchantId, customerId);
    if (!key) {
      setSelectedIds(new Set());
      return;
    }
    let cancelled = false;
    AsyncStorage.getItem(key)
      .then((raw) => {
        if (cancelled) return;
        try {
          const arr = raw ? (JSON.parse(raw) as string[]) : [];
          setSelectedIds(new Set(arr));
        } catch {
          setSelectedIds(new Set());
        }
      })
      .catch(() => {
        if (!cancelled) setSelectedIds(new Set());
      });
    return () => { cancelled = true; };
  }, [merchantId, customerId]);

  // Persist to AsyncStorage on every change. Best-effort — if the
  // write fails the set still lives in memory for this session.
  const persist = useCallback((set: Set<string>) => {
    const key = storageKey(merchantId, customerId);
    if (!key) return;
    AsyncStorage.setItem(key, JSON.stringify(Array.from(set))).catch(() => {});
  }, [merchantId, customerId]);

  const addMilestone = useCallback((id: string) => {
    setSelectedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      persist(next);
      return next;
    });
  }, [persist]);

  const removeMilestone = useCallback((id: string) => {
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      persist(next);
      return next;
    });
  }, [persist]);

  const toggleMilestone = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(next);
      return next;
    });
  }, [persist]);

  const clearMilestones = useCallback(() => {
    setSelectedIds(new Set());
    const key = storageKey(merchantId, customerId);
    if (key) AsyncStorage.removeItem(key).catch(() => {});
  }, [merchantId, customerId]);

  const isMilestoneSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  const value = useMemo<RewardSelectionContextType>(() => ({
    selectedMilestoneIds: selectedIds,
    toggleMilestone,
    addMilestone,
    removeMilestone,
    clearMilestones,
    isMilestoneSelected,
  }), [selectedIds, toggleMilestone, addMilestone, removeMilestone, clearMilestones, isMilestoneSelected]);

  return (
    <RewardSelectionContext.Provider value={value}>
      {children}
    </RewardSelectionContext.Provider>
  );
}

export function useRewardSelection(): RewardSelectionContextType {
  const ctx = useContext(RewardSelectionContext);
  if (!ctx) {
    throw new Error('useRewardSelection must be used within RewardSelectionProvider');
  }
  return ctx;
}
