import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasRequiredMoyasarEvents,
  isCorrectNooksMoyasarWebhook,
  isLegacyRailwayRootWebhook,
  NOOKS_MOYASAR_WEBHOOK_URL,
  REQUIRED_MOYASAR_PAYMENT_EVENTS,
} from '../utils/moyasarWebhookConfiguration';

test('recognizes the exact Nooks HTTPS POST webhook with every required payment event', () => {
  assert.equal(isCorrectNooksMoyasarWebhook({
    id: 'hook-1',
    http_method: 'post',
    url: NOOKS_MOYASAR_WEBHOOK_URL,
    events: [...REQUIRED_MOYASAR_PAYMENT_EVENTS],
  }), true);
});

test('fails closed on wrong path, method, scheme, or a missing event', () => {
  assert.equal(isCorrectNooksMoyasarWebhook({
    http_method: 'post',
    url: 'https://nooks.space/',
    events: [...REQUIRED_MOYASAR_PAYMENT_EVENTS],
  }), false);
  assert.equal(isCorrectNooksMoyasarWebhook({
    http_method: 'get',
    url: NOOKS_MOYASAR_WEBHOOK_URL,
    events: [...REQUIRED_MOYASAR_PAYMENT_EVENTS],
  }), false);
  assert.equal(isCorrectNooksMoyasarWebhook({
    http_method: 'post',
    url: NOOKS_MOYASAR_WEBHOOK_URL,
    events: REQUIRED_MOYASAR_PAYMENT_EVENTS.filter((event) => event !== 'payment_failed'),
  }), false);
});

test('recognizes only the obsolete Railway root sink', () => {
  assert.equal(isLegacyRailwayRootWebhook({
    http_method: 'post',
    url: 'https://alsdraft0-production.up.railway.app/',
    events: [...REQUIRED_MOYASAR_PAYMENT_EVENTS],
  }), true);
  assert.equal(isLegacyRailwayRootWebhook({
    http_method: 'post',
    url: 'https://alsdraft0-production.up.railway.app/api/payment/webhook',
    events: [...REQUIRED_MOYASAR_PAYMENT_EVENTS],
  }), false);
});

test('required event check tolerates additional events but not typos', () => {
  assert.equal(hasRequiredMoyasarEvents([...REQUIRED_MOYASAR_PAYMENT_EVENTS, 'payment_verified']), true);
  assert.equal(hasRequiredMoyasarEvents(['payment_paid', 'payment_faild']), false);
});
