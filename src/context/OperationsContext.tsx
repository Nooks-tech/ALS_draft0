/**
 * Merchant operations from Nooks: store_status, prep_time_minutes, delivery_mode.
 * Kept fresh by a foreground-only poll. SCAL-001 removed the Supabase
 * Realtime binding on app_config (it held a Postgres Changes connection
 * per app instance — the 200-connection ceiling); SCAL-002 made the poll
 * foreground-only at 60s. The server caches this endpoint for ~10s and
 * order intake is gated server-side at POST time, so near-instant updates
 * were redundant.
 *
 * The server now returns a unified closed state (effective_status /
 * closed_reason / reopens_at) covering manual close, the busy timer,
 * scheduled hours, and billing closure. `effectivelyClosed` is what
 * screens should gate on; `isClosed`/`isBusy` remain for display.
 */
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

const POLL_MS = 60 * 1000;

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

  // SCAL-002: poll ONLY while the app is foregrounded. A backgrounded app
  // holds no interval and issues no requests; foregrounding refetches
  // immediately and restarts the 60s cadence. Store open/close latency is
  // bounded by POLL_MS — fine, because order intake is gated server-side
  // at POST time (checkOrderAllowed), never by this display poll.
  // SCAL-001: the Supabase Realtime binding on app_config was removed —
  // this foreground poll is now the sole freshness mechanism.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void refetch();
      timer = setInterval(() => void refetch(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') start();
      else stop();
    });
    return () => {
      stop();
      sub.remove();
    };
  }, [refetch]);

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
    // Only the BUSY closure gets a 1 Hz countdown (its banner shows
    // MM:SS). Outside-hours closures show a static "opens at HH:MM"
    // and reopen via the 15s poll — ticking every consumer at 1 Hz for
    // hours would be pure re-render churn. Old servers without
    // reopens_at still tick: reopenSecondsLeft was seeded from the
    // legacy busy fields at fetch time.
    if (!effectivelyClosed || closedReason !== 'busy') {
      if (!effectivelyClosed) setReopenSecondsLeft(0);
      return;
    }
    const t = setInterval(() => {
      if (isBusy) setBusySecondsLeft((prev) => Math.max(0, prev - 1));
      setReopenSecondsLeft((prev) => {
        const next = Math.max(0, prev - 1);
        // Timer ran out (busy ended) — confirm with the server once so
        // the store flips open immediately instead of waiting for the
        // next 15s poll.
        if (next === 0 && prev > 0 && !expiryRefetchedRef.current) {
          expiryRefetchedRef.current = true;
          void refetch();
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [isBusy, effectivelyClosed, closedReason, refetch]);

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
