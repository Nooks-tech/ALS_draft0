import assert from 'node:assert/strict';
import test from 'node:test';
import { isWebOrder, shouldSendCustomerOrderPush } from '../utils/orderSource';

test('web orders never send customer order pushes', () => {
  assert.equal(shouldSendCustomerOrderPush({ id: 'web-new', order_source: 'web' }), false);
  assert.equal(shouldSendCustomerOrderPush({ id: 'web-legacy', order_source: null }), false);
});

test('native orders retain customer order pushes', () => {
  assert.equal(isWebOrder({ id: 'order-1', order_source: 'native' }), false);
  assert.equal(shouldSendCustomerOrderPush({ id: 'order-1', order_source: 'native' }), true);
});
