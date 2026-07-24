// 2026-07-24 legal review, Tier 1 finding #1/#2: "Sentry anonymized" was a
// false claim — the scrubber removed secrets (auth headers, OTP codes)
// but not personal data. Covers the widened PII redaction (Saudi phone
// patterns, email addresses, PII-named keys) alongside the pre-existing
// secret scrubbing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubSentryEvent } from '../utils/sentryContext';
import type { Event as SentryEvent } from '@sentry/node';

function eventWithRequestData(data: Record<string, unknown>): SentryEvent {
  return { request: { data } } as unknown as SentryEvent;
}

test('redacts international-format Saudi phone numbers embedded in free text', () => {
  const scrubbed = scrubSentryEvent(
    eventWithRequestData({ note: 'call the customer at +966512345678 about the order' }),
  )!;
  const note = (scrubbed.request!.data as any).note as string;
  assert.doesNotMatch(note, /\d{9,}/);
  assert.match(note, /\[redacted\]/);
});

test('redacts local-format Saudi mobile numbers (05XXXXXXXX)', () => {
  const scrubbed = scrubSentryEvent(eventWithRequestData({ note: 'reach at 0512345678 please' }))!;
  const note = (scrubbed.request!.data as any).note as string;
  assert.doesNotMatch(note, /\b05\d{8}\b/);
  assert.match(note, /\[redacted\]/);
});

test('does not false-positive on ordinary short numbers', () => {
  const scrubbed = scrubSentryEvent(eventWithRequestData({ note: 'order #12345 has 3 items' }))!;
  const note = (scrubbed.request!.data as any).note as string;
  assert.equal(note, 'order #12345 has 3 items');
});

test('redacts email addresses inside free text', () => {
  const scrubbed = scrubSentryEvent(
    eventWithRequestData({ note: 'customer emailed hello@example.com about a refund' }),
  )!;
  const note = (scrubbed.request!.data as any).note as string;
  assert.doesNotMatch(note, /@/);
  assert.match(note, /\[redacted\]/);
});

test('redacts values of PII-named keys regardless of content, case-insensitively', () => {
  const scrubbed = scrubSentryEvent(
    eventWithRequestData({
      Full_Name: 'Abdullah Al-Saedi',
      Phone_Number: '0512345678',
      Email: 'abdullah@example.com',
      Delivery_Address: 'Madinah, some street',
      Mobile: '0598765432',
      unrelated_field: 'keep me',
    }),
  )!;
  const data = scrubbed.request!.data as any;
  assert.equal(data.Full_Name, '[redacted]');
  assert.equal(data.Phone_Number, '[redacted]');
  assert.equal(data.Email, '[redacted]');
  assert.equal(data.Delivery_Address, '[redacted]');
  assert.equal(data.Mobile, '[redacted]');
  assert.equal(data.unrelated_field, 'keep me');
});

test('redacts PII nested inside objects and arrays', () => {
  const scrubbed = scrubSentryEvent(
    eventWithRequestData({
      customer: { name: 'Abdullah', phone: '0512345678' },
      items: [{ note: 'deliver to 0598765432' }],
    }),
  )!;
  const data = scrubbed.request!.data as any;
  assert.equal(data.customer.name, '[redacted]');
  assert.equal(data.customer.phone, '[redacted]');
  assert.doesNotMatch(data.items[0].note, /\b05\d{8}\b/);
});

test('redacts PII in query_string entries', () => {
  const event = { request: { query_string: { email: 'abdullah@example.com' } } } as unknown as SentryEvent;
  const scrubbed = scrubSentryEvent(event)!;
  assert.equal((scrubbed.request!.query_string as any).email, '[redacted]');
});

test('redacts PII inside breadcrumb data.body and breadcrumb message text', () => {
  const event = {
    breadcrumbs: [
      {
        message: 'OTP sent to 0512345678',
        data: { body: { email: 'abdullah@example.com' } },
      },
    ],
  } as unknown as SentryEvent;
  const scrubbed = scrubSentryEvent(event)!;
  const bc = scrubbed.breadcrumbs![0];
  assert.doesNotMatch(bc.message!, /\b05\d{8}\b/);
  assert.equal((bc.data!.body as any).email, '[redacted]');
});

test('keeps existing auth-header and OTP-code scrubbing intact alongside the new PII scrubbing', () => {
  const event = {
    request: {
      headers: { Authorization: 'Bearer secret-token', 'X-Cron-Secret': 'abc' },
      data: { code: '123456', full_name: 'Abdullah' },
    },
  } as unknown as SentryEvent;
  const scrubbed = scrubSentryEvent(event)!;
  assert.equal((scrubbed.request!.headers as any).Authorization, '[redacted]');
  assert.equal((scrubbed.request!.headers as any)['X-Cron-Secret'], '[redacted]');
  const data = scrubbed.request!.data as any;
  assert.equal(data.code, '[redacted]');
  assert.equal(data.full_name, '[redacted]');
});

test('never throws even on a malformed event shape', () => {
  assert.doesNotThrow(() => scrubSentryEvent({} as SentryEvent));
  assert.doesNotThrow(() => scrubSentryEvent({ request: {} } as SentryEvent));
});
