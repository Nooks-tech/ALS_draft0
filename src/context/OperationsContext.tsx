/**
 * Merchant operations from Nooks: store_status, prep_time_minutes, delivery_mode.
 * Uses Supabase Realtime on app_config for instant updates, with API polling as fallback.
 */
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../api/supabase';
import { fetchNooksOperations, type NooksOperations } from '../api/nooksOperations';
import { useMerchant } from './MerchantContext';

type OperationsContextType = {
  operations: NooksOperations | null;
  loading: boolean;
  refetch: () => Promise<void>;
  isClosed: boolean;
  isBusy: boolean;
  isPickupOnly: boolean;
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
  prepTimeMinutes: 0,
  busySecondsLeft: 0,
});

const POLL_MS = 15 * 1000;

function withStableBusyStart(ops: NooksOperations, currentBusyStartMs: number | null): NooksOperations {
  if (ops.store_status !== 'busy') return ops;
  if (ops.busy_started_at) return ops;
  if (!currentBusyStartMs) return ops;
  return {
    ...ops,
    busy_started_at: new Date(currentBusyStartMs).toISOString(),
  };
}

export function OperationsProvider({ children }: { children: ReactNode }) {
  const { merchantId } = useMerchant();
  const [operations, setOperations] = useState<NooksOperations | null>(null);
  const [loading, setLoading] = useState(false);
  const [busySecondsLeft, setBusySecondsLeft] = useState(0);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const busyStartedAtRef = useRef<number | null>(null);
  const cacheKey = `@als_operations_${merchantId || 'default'}`;
  const busyAnchorCacheKey = `@als_busy_anchor_${merchantId || 'default'}`;

  useEffect(() => {
    if (!merchantId.trim()) return;
    Promise.all([AsyncStorage.getItem(cacheKey), AsyncStorage.getItem(busyAnchorCacheKey)])
      .then(([raw, busyAnchorRaw]) => {
        if (busyAnchorRaw) {
          const parsedAnchor = Number(busyAnchorRaw);
          if (Number.isFinite(parsedAnchor) && parsedAnchor > 0) {
            busyStartedAtRef.current = parsedAnchor;
          }
        }
        if (!raw) return;
        const cached = JSON.parse(raw) as NooksOperations;
        if (!cached || typeof cached !== 'object') return;
        setOperations(cached);
        if (cached.store_status === 'busy') {
          if (cached.busy_started_at) {
            const startedAt = new Date(cached.busy_started_at).getTime();
            if (Number.isFinite(startedAt) && startedAt > 0) {
              busyStartedAtRef.current = startedAt;
            }
          }
        }
      })
      .catch(() => {});
  }, [merchantId, cacheKey, busyAnchorCacheKey]);

  const refetch = useCallback(async () => {
    if (!merchantId.trim()) return;
    setLoading(true);
    try {
      const data = await fetchNooksOperations(merchantId);
      const next = withStableBusyStart(data ?? defaultOps, busyStartedAtRef.current);
      setOperations(next);
      AsyncStorage.setItem(cacheKey, JSON.stringify(next)).catch(() => {});
      if (next.store_status === 'busy') {
        if (next.busy_started_at) {
          const startedAt = new Date(next.busy_started_at).getTime();
          if (Number.isFinite(startedAt)) {
            busyStartedAtRef.current = startedAt;
          }
        } else if (!busyStartedAtRef.current) {
          // Keep existing timer anchor if server did not send busy_started_at.
          busyStartedAtRef.current = Date.now();
        }
        if (busyStartedAtRef.current) {
          AsyncStorage.setItem(busyAnchorCacheKey, String(busyStartedAtRef.current)).catch(() => {});
        }
      } else {
        busyStartedAtRef.current = null;
        setBusySecondsLeft(0);
        AsyncStorage.removeItem(busyAnchorCacheKey).catch(() => {});
      }
    } catch {
      setOperations(defaultOps);
    } finally {
      setLoading(false);
    }
  }, [merchantId, cacheKey, busyAnchorCacheKey]);

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
    if (!supabase || !merchantId.trim()) return;
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
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          const realtimeOps: NooksOperations = {
            store_status: (row.store_status as NooksOperations['store_status']) ?? 'open',
            prep_time_minutes: typeof row.prep_time_minutes === 'number' ? row.prep_time_minutes : 0,
            delivery_mode: (row.delivery_mode as NooksOperations['delivery_mode']) ?? 'delivery_and_pickup',
            busy_started_at: typeof row.busy_started_at === 'string' ? row.busy_started_at : null,
          };
          const stableRealtimeOps = withStableBusyStart(realtimeOps, busyStartedAtRef.current);
          AsyncStorage.setItem(cacheKey, JSON.stringify(stableRealtimeOps)).catch(() => {});
          setOperations(stableRealtimeOps);
          if ((row.store_status as string) === 'busy') {
            if (typeof stableRealtimeOps.busy_started_at === 'string') {
              const startedAt = new Date(stableRealtimeOps.busy_started_at).getTime();
              if (Number.isFinite(startedAt)) {
                busyStartedAtRef.current = startedAt;
              }
            } else if (!busyStartedAtRef.current) {
              busyStartedAtRef.current = Date.now();
            }
            if (busyStartedAtRef.current) {
              AsyncStorage.setItem(busyAnchorCacheKey, String(busyStartedAtRef.current)).catch(() => {});
            }
          } else {
            busyStartedAtRef.current = null;
            setBusySecondsLeft(0);
            AsyncStorage.removeItem(busyAnchorCacheKey).catch(() => {});
          }
        }
      )
      .subscribe();

    return () => {
      channelRef.current?.unsubscribe();
      channelRef.current = null;
    };
  }, [merchantId, cacheKey, busyAnchorCacheKey]);

  const isClosed = operations?.store_status === 'closed';
  const isBusy = operations?.store_status === 'busy';
  const isPickupOnly = operations?.delivery_mode === 'pickup_only';
  const prepTimeMinutes = operations?.prep_time_minutes ?? 0;

  useEffect(() => {
    if (!isBusy) {
      setBusySecondsLeft(0);
      return;
    }
    const tick = () => {
      const prepSeconds = Math.max(0, (operations?.prep_time_minutes ?? 0) * 60);
      const start = busyStartedAtRef.current ?? Date.now();
      const elapsed = Math.floor((Date.now() - start) / 1000);
      setBusySecondsLeft(Math.max(0, prepSeconds - elapsed));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [isBusy, operations?.prep_time_minutes]);

  return (
    <OperationsContext.Provider value={{ operations, loading, refetch, isClosed, isBusy, isPickupOnly, prepTimeMinutes, busySecondsLeft }}>
      {children}
    </OperationsContext.Provider>
  );
}

export const useOperations = () => useContext(OperationsContext);
