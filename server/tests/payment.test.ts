import test from "node:test";
import assert from "node:assert/strict";
import { calculateCommission, calculateMoyasarFee, normalizeMerchantId } from "../services/payment";
import { buildPaymentWebhookUpdates } from "../routes/payment";

test("normalizeMerchantId trims usable merchant ids and rejects empty values", () => {
  assert.equal(normalizeMerchantId(" merchant-1 "), "merchant-1");
  assert.equal(normalizeMerchantId("   "), null);
  assert.equal(normalizeMerchantId(null), null);
});

test("calculateCommission remains zero under SaaS pricing", () => {
  assert.deepEqual(calculateCommission(120, 15), { rate: 0, amount: 0 });
});

test("calculateMoyasarFee applies mada cap and fraud fee", () => {
  assert.equal(calculateMoyasarFee(100, "mada"), 2);
  assert.equal(calculateMoyasarFee(50000, "mada"), 201);
});

test("buildPaymentWebhookUpdates maps success and failure states consistently", () => {
  const paid = buildPaymentWebhookUpdates({
    status: "paid",
    paymentId: "pay_123",
    sourceCompany: "mada",
  });
  assert.equal(paid.payment_id, "pay_123");
  assert.equal(paid.payment_method, "mada");

  const failed = buildPaymentWebhookUpdates({
    status: "failed",
    paymentId: "pay_456",
  });
  assert.equal(failed.status, "Cancelled");
  assert.equal(failed.cancellation_reason, "Payment failed");
  assert.equal(failed.cancelled_by, "system");
});
