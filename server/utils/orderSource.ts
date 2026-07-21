export type OrderSourceRecord = {
  id?: string | null;
  order_source?: string | null;
};

/** Backward-compatible while legacy web-* rows are being backfilled. */
export function isWebOrder(order: OrderSourceRecord): boolean {
  return order.order_source === 'web' || String(order.id ?? '').startsWith('web-');
}

export function shouldSendCustomerOrderPush(order: OrderSourceRecord): boolean {
  return !isWebOrder(order);
}
