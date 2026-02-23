/**
 * Merchant operations from Nooks: store_status, prep_time_minutes, delivery_mode.
 * Uses Supabase Realtime on app_config for instant updates, with API polling as fallback.
 */
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
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
};

const defaultOps: NooksOperations = {
  store_status: 'open',
  prep_time_minutes: 0,
  delivery_mode: 'delivery_and_pickup',
};

const OperationsContext = createContext<OperationsContextType>({
  operations: null,
  loading: false,
  refetch: async () => {},
  isClosed: false,
  isBusy: false,
  isPickupOnly: false,
  prepTimeMinutes: 0,
});

const POLL_MS = 60 * 1000;

export function OperationsProvider({ children }: { children: ReactNode }) {
  const { merchantId } = useMerchant();
  const [operations, setOperations] = useState<NooksOperations | null>(null);
  const [loading, setLoading] = useState(false);
  const channelRef = useRef<RealtimeChannel | null>(null);

  const refetch = useCallback(async () => {
    if (!merchantId.trim()) return;
    setLoading(true);
    try {
      const data = await fetchNooksOperations(merchantId);
      setOperations(data ?? defaultOps);
    } catch {
      setOperations(defaultOps);
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    refetch();
    const t = setInterval(refetch, POLL_MS);
    return () => clearInterval(t);
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
          setOperations({
            store_status: (row.store_status as NooksOperations['store_status']) ?? 'open',
            prep_time_minutes: typeof row.prep_time_minutes === 'number' ? row.prep_time_minutes : 0,
            delivery_mode: (row.delivery_mode as NooksOperations['delivery_mode']) ?? 'delivery_and_pickup',
          });
        }
      )
      .subscribe();

    return () => {
      channelRef.current?.unsubscribe();
      channelRef.current = null;
    };
  }, [merchantId]);

  const isClosed = operations?.store_status === 'closed';
  const isBusy = operations?.store_status === 'busy';
  const isPickupOnly = operations?.delivery_mode === 'pickup_only';
  const prepTimeMinutes = operations?.prep_time_minutes ?? 0;

  return (
    <OperationsContext.Provider value={{ operations, loading, refetch, isClosed, isBusy, isPickupOnly, prepTimeMinutes }}>
      {children}
    </OperationsContext.Provider>
  );
}

export const useOperations = () => useContext(OperationsContext);
