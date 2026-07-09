/**
 * Merchant operations from Nooks: store_status, prep_time_minutes, delivery_mode.
 * Uses Supabase Realtime on app_config for instant updates, with API polling as fallback.
 *
 * The server now returns a unified closed state (effective_status /
 * closed_reason / reopens_at) covering manual close, the busy timer,
 * scheduled hours, and billing closure. `effectivelyClosed` is what
 * screens should gate on; `isClosed`/`isBusy` remain for display.
 */
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../api/supabase';
import { fetchNooksOperations, type ClosedReason, type NooksOperations } from '../api/nooksOperations';
import { useCart } from './CartContext';
import { useMerchant } from './MerchantContext';

type OperationsContextType = {
  operations: NooksOperations | null;
  loading: boolean;
  refetch: () => Promise<void>;
  isClosed: boolean;
  isBusy: boolean;
  isPickupOnly: boolean;
  // Unified closed state — true when the branch cannot take orders for
  // ANY reason (manual close, busy timer, outside hours, billing).
  // This is the flag checkout/cart/order-type must gate on.
  effectivelyClosed: boolean;
  closedReason: ClosedReason | null;
  reopensAt: string | null;
  // Ticking countdown to reopens_at (0 when unknown/none). When it
  // crosses zero the context refetches so the store flips open without
  // waiting for the next poll.
  reopenSecondsLeft: number;
  // Per-order-type enable flags resolved per selected branch.
  // Default true when the server didn't return a value (pre-migration
  // branches) — the customer can still pick the type; server gates
  // it independently if disabled.
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  drivethruEnabled: boolean;
  prepTimeMinutes: number;
  busySecondsLeft: number;
};

const defaultOps: NooksOperations = {
  store_status: 'open',
  prep_time_minutes: 0,
  delivery_mode: 'delivery_and_pickup',
  busy_started_at: null,
};

const OperationsContext = createContext<OperationsContextType>({
  operations: null,
  loading: false,
  refetch: async () => {},
  isClosed: false,
  isBusy: false,
  isPickupOnly: false,
  effectivelyClosed: false,
  closedReason: null,
  reopensAt: null,
  reopenSecondsLeft: 0,
  deliveryEnabled: true,
  pickupEnabled: true,
  drivethruEnabled: true,
  prepTimeMinutes: 0,
  busySecondsLeft: 0,
});

const POLL_MS = 15 * 1000;

function deriveReopenSeconds(ops: NooksOperations | null): number {
  if (!ops) return 0;
  if (typeof ops.reopens_at === 'string') {
    const at = Date.parse(ops.reopens_at);
    if (Number.isFinite(at)) return Math.max(0, Math.floor((at - Date.now()) / 1000));
  }
  return deriveBusySeconds(ops);
}

function deriveBusySeconds(ops: NooksOperations | null): number {
  if (!ops || ops.store_status !== 'busy') return 0;
  if (typeof ops.busy_until === 'string') {
    const until = Date.parse(ops.busy_until);
    if (Number.isFinite(until)) return Math.max(0, Math.floor((until - Date.now()) / 1000));
  }
  if (typeof ops.busy_seconds_left === 'number' && Number.isFinite(ops.busy_seconds_left)) {
    return Math.max(0, Math.floor(ops.busy_seconds_left));
  }
  if (typeof ops.busy_started_at === 'string') {
    const startedAt = Date.parse(ops.busy_started_at);
    if (Number.isFinite(startedAt)) {
      const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      return Math.max(0, (ops.prep_time_minutes ?? 0) * 60 - elapsed);
    }
  }
  return 0;
}

export function OperationsProvider({ children }: { children: ReactNode }) {
  const { merchantId } = useMerchant();
  const { selectedBranch } = useCart();
  const [operations, setOperations] = useState<NooksOperations | null>(null);
  const [loading, setLoading] = useState(false);
  const [busySecondsLeft, setBusySecondsLeft] = useState(0);
  const [reopenSecondsLeft, setReopenSecondsLeft] = useState(0);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const realtimeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiryRefetchedRef = useRef(false);
  const selectedBranchId = selectedBranch?.id?.trim() || '';
  const cacheKey = `@als_operations_${merchantId || 'default'}_${selectedBranchId || 'merchant'}`;

  useEffect(() => {
    if (!merchantId.trim()) return;
    AsyncStorage.getItem(cacheKey)
      .then((raw) => {
        if (!raw) return;
        const cached = JSON.parse(raw) as NooksOperations;
        if (!cached || typeof cached !== 'object') return;
        setOperations(cached);
        setBusySecondsLeft(deriveBusySeconds(cached));
        setReopenSecondsLeft(deriveReopenSeconds(cached));
      })
      .catch(() => {});
  }, [merchantId, cacheKey]);

  const refetch = useCallback(async () => {
    if (!merchantId.trim()) return;
    setLoading(true);
    try {
      const data = await fetchNooksOperations(merchantId, selectedBranchId || undefined);
      const next = data ?? defaultOps;
      setOperations(next);
      setBusySecondsLeft(deriveBusySeconds(next));
      setReopenSecondsLeft(deriveReopenSeconds(next));
      expiryRefetchedRef.current = false;
      AsyncStorage.setItem(cacheKey, JSON.stringify(next)).catch(() => {});
    } catch {
      setOperations(defaultOps);
      setBusySecondsLeft(0);
      setReopenSecondsLeft(0);
    } finally {
      setLoading(false);
    }
  }, [merchantId, selectedBranchId, cacheKey]);

  useEffect(() => {
    refetch();
    const t = setInterval(refetch, POLL_MS);
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refetch();
    });
    return () => {
      clearInterval(t);
      appStateSub.remove();
    };
  }, [refetch]);

  useEffect(() => {
    if (!supabase || !merchantId.trim() || selectedBranchId) return;
    channelRef.current = supabase
      .channel(`ops-${merchantId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'app_config',
          filter: `merchant_id=eq.${merchantId}`,
        },
        () => {
          // Don't build operations from the raw row — that bypassed the
          // server-computed state (hours, busy timer, billing closure,
          // per-branch aggregation). Use the event purely as a "something
          // changed" signal and refetch, debounced against bursts.
          if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
          realtimeDebounceRef.current = setTimeout(() => {
            realtimeDebounceRef.current = null;
            void refetch();
          }, 500);
        }
      )
      .subscribe();

    return () => {
      if (realtimeDebounceRef.current) {
        clearTimeout(realtimeDebounceRef.current);
        realtimeDebounceRef.current = null;
      }
      channelRef.current?.unsubscribe();
      channelRef.current = null;
    };
  }, [merchantId, selectedBranchId, refetch]);

  const isClosed = operations?.store_status === 'closed';
  const isBusy = operations?.store_status === 'busy';
  const isPickupOnly = operations?.delivery_mode === 'pickup_only';
  // Unified gate: trust the server field when present, otherwise fall
  // back to the legacy statuses (old servers / cached responses).
  const effectivelyClosed = operations
    ? operations.effective_status === 'open'
      ? false
      : operations.effective_status === 'closed'
        ? true
        : isClosed || isBusy
    : false;
  const closedReason = effectivelyClosed
    ? (operations?.closed_reason ?? (isBusy ? 'busy' : 'manual'))
    : null;
  const reopensAt = effectivelyClosed ? (operations?.reopens_at ?? operations?.busy_until ?? null) : null;
  // Resolve per-type flags from the server response. Treat missing
  // booleans as enabled — gracefully handles pre-migration branches.
  const deliveryEnabled =
    typeof operations?.delivery_enabled === 'boolean'
      ? operations.delivery_enabled
      : !isPickupOnly;
  const pickupEnabled =
    typeof operations?.pickup_enabled === 'boolean' ? operations.pickup_enabled : true;
  const drivethruEnabled =
    typeof operations?.drivethru_enabled === 'boolean' ? operations.drivethru_enabled : true;
  const prepTimeMinutes = operations?.prep_time_minutes ?? 0;

  useEffect(() => {
    if (!isBusy) setBusySecondsLeft(0);
    if (!effectivelyClosed || !reopensAt) {
      setReopenSecondsLeft(0);
      return;
    }
    const t = setInterval(() => {
      if (isBusy) setBusySecondsLeft((prev) => Math.max(0, prev - 1));
      setReopenSecondsLeft((prev) => {
        const next = Math.max(0, prev - 1);
        // Timer ran out (busy ended / opening time reached) — confirm
        // with the server once so the store flips open immediately
        // instead of waiting for the next 15s poll.
        if (next === 0 && prev > 0 && !expiryRefetchedRef.current) {
          expiryRefetchedRef.current = true;
          void refetch();
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [isBusy, effectivelyClosed, reopensAt, refetch]);

  return (
    <OperationsContext.Provider
      value={{
        operations,
        loading,
        refetch,
        isClosed,
        isBusy,
        isPickupOnly,
        effectivelyClosed,
        closedReason,
        reopensAt,
        reopenSecondsLeft,
        deliveryEnabled,
        pickupEnabled,
        drivethruEnabled,
        prepTimeMinutes,
        busySecondsLeft,
      }}
    >
      {children}
    </OperationsContext.Provider>
  );
}

export const useOperations = () => useContext(OperationsContext);
