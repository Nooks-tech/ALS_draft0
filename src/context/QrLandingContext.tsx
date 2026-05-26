/**
 * QrLandingContext — holds the QR-attribution data extracted from
 * the entry URL (`?q=<qrCodeId>&branch=<id>&type=<orderType>`). The
 * customer app reads it to:
 *   1. Pre-select branch + order_type so the customer doesn't pick again
 *   2. Send qrCodeId on commit so the order gets attributed to the QR
 *   3. Display "Dining at <table>" copy when type=dine_in
 *
 * Resolution happens server-side: the customer app sends `qrCodeId`
 * with the commit; the server resolves it against merchant_qr_codes
 * and overrides branch_id + foodics_table_id from the QR row (never
 * trusts client-supplied table/branch identity).
 *
 * Lives ABOVE CartContext + OperationsContext + MenuContext so those
 * consumers can read pre-selected values during their initial mount.
 *
 * Why a separate context (not folded into MerchantContext):
 *  - MerchantContext.merchantId is platform-truth (set at build time
 *    for native, URL param for web). QR landing data is a transient
 *    session-level concern that gets cleared once an order is placed.
 *  - Keeping it isolated makes it cheap to reset (`clearLanding()`)
 *    without re-triggering all merchant-scoped fetchers.
 */
import * as Linking from 'expo-linking';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';

export type LandingOrderType = 'pickup' | 'delivery' | 'drivethru' | 'dine_in';

export type QrLanding = {
  qrCodeId: string | null;
  branchId: string | null;
  orderType: LandingOrderType | null;
  /** Optional display name resolved by the backend on first fetch
   *  (e.g. "Indoor / Table 5"). Stays null until /api/public/merchants/.../qr/<id>
   *  responds. Used by cart/checkout to render "Dining at <name>". */
  tableName: string | null;
};

type QrLandingContextType = {
  landing: QrLanding;
  /** Called when the customer abandons the QR-attributed cart (e.g.
   *  switches merchants). Resets all fields to null. */
  clearLanding: () => void;
  /** Called by CartContext after it merges in the cached qr-table-name
   *  from a /api/public/merchants/.../qr/<qrCodeId> fetch. */
  setTableName: (name: string | null) => void;
};

const QrLandingContext = createContext<QrLandingContextType>({
  landing: { qrCodeId: null, branchId: null, orderType: null, tableName: null },
  clearLanding: () => {},
  setTableName: () => {},
});

function isOrderType(v: unknown): v is LandingOrderType {
  return v === 'pickup' || v === 'delivery' || v === 'drivethru' || v === 'dine_in';
}

function parseUrl(url: string | null): Partial<QrLanding> {
  if (!url) return {};
  try {
    const parsed = Linking.parse(url);
    const q = parsed.queryParams ?? {};
    const qrRaw = q.q ?? q.qr ?? null;
    const branchRaw = q.branch ?? q.branch_id ?? null;
    const typeRaw = q.type ?? q.order_type ?? null;
    return {
      qrCodeId: typeof qrRaw === 'string' && qrRaw.trim() ? qrRaw.trim() : null,
      branchId: typeof branchRaw === 'string' && branchRaw.trim() ? branchRaw.trim() : null,
      orderType: isOrderType(typeRaw) ? typeRaw : null,
    };
  } catch {
    return {};
  }
}

export const QrLandingProvider = ({ children }: { children: ReactNode }) => {
  const [landing, setLanding] = useState<QrLanding>({
    qrCodeId: null,
    branchId: null,
    orderType: null,
    tableName: null,
  });

  // Resolve on mount from the initial URL. expo-linking handles
  // platform differences (iOS Universal Links, Android intents, web URL).
  useEffect(() => {
    Linking.getInitialURL().then((url) => {
      const parsed = parseUrl(url);
      if (parsed.qrCodeId || parsed.branchId || parsed.orderType) {
        setLanding((prev) => ({
          qrCodeId: parsed.qrCodeId ?? prev.qrCodeId,
          branchId: parsed.branchId ?? prev.branchId,
          orderType: parsed.orderType ?? prev.orderType,
          tableName: prev.tableName,
        }));
      }
    });

    // Listen for URL changes (e.g. deep link while app is running)
    const sub = Linking.addEventListener('url', (e) => {
      const parsed = parseUrl(e.url);
      if (parsed.qrCodeId || parsed.branchId || parsed.orderType) {
        // Reset tableName whenever the URL changes — a new QR may
        // be a different table, the resolver call refreshes it.
        setLanding({
          qrCodeId: parsed.qrCodeId ?? null,
          branchId: parsed.branchId ?? null,
          orderType: parsed.orderType ?? null,
          tableName: null,
        });
      }
    });
    return () => sub.remove();
  }, []);

  const clearLanding = useCallback(() => {
    setLanding({ qrCodeId: null, branchId: null, orderType: null, tableName: null });
  }, []);

  const setTableName = useCallback((name: string | null) => {
    setLanding((prev) => ({ ...prev, tableName: name }));
  }, []);

  return (
    <QrLandingContext.Provider value={{ landing, clearLanding, setTableName }}>
      {children}
    </QrLandingContext.Provider>
  );
};

export const useQrLanding = () => useContext(QrLandingContext);
