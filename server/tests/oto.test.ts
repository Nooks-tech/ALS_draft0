import test from "node:test";
import assert from "node:assert/strict";
import { resolveScopedRefreshToken } from "../services/oto";
import { buildOrderStatusUpdate, mapOtoStatusToOrderStatus } from "../routes/oto";

test("resolveScopedRefreshToken fails closed for merchant-scoped requests", () => {
  assert.equal(resolveScopedRefreshToken("merchant-1", null), null);
  assert.equal(resolveScopedRefreshToken("merchant-1", "merchant-token"), "merchant-token");
});

test("resolveScopedRefreshToken allows platform fallback only when merchant is absent", () => {
  assert.equal(resolveScopedRefreshToken(null, "platform-token"), "platform-token");
});

test("mapOtoStatusToOrderStatus keeps delivery lifecycle aligned", () => {
  assert.equal(mapOtoStatusToOrderStatus("picked_up"), "Ready");
  assert.equal(mapOtoStatusToOrderStatus("out_for_delivery"), "Out for delivery");
  assert.equal(mapOtoStatusToOrderStatus("delivered"), "Delivered");
  assert.equal(mapOtoStatusToOrderStatus("canceled"), "Cancelled");
});

test("buildOrderStatusUpdate stamps delivered_at only for delivered orders", () => {
  const delivered = buildOrderStatusUpdate("Delivered");
  const ready = buildOrderStatusUpdate("Ready");
  assert.equal(typeof delivered.delivered_at, "string");
  assert.equal(ready.delivered_at, undefined);
});
