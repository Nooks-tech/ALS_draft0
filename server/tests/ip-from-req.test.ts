// INPUT-2 (2026-07-10 audit) — rate-limit / OTP IP keys must come from the
// trust-proxy-derived req.ip, NOT the client-spoofable leftmost
// X-Forwarded-For token.
//
// Two layers proven here:
//   1. Unit: ipFromReq ignores the XFF header entirely and falls back
//      req.ip → socket.remoteAddress → 'unknown'.
//   2. Integration: under `trust proxy: 1` (exactly what server/index.ts
//      sets), Express resolves req.ip to the RIGHTMOST XFF entry — the one
//      appended by the trusted edge — so entries a client prepends itself
//      can't rotate the rate-limit key. The old leftmost read returned the
//      attacker-controlled value.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { ipFromReq } from '../utils/rateLimit';

function fakeReq(partial: Record<string, unknown>) {
  return { headers: {}, ...partial } as unknown as Parameters<typeof ipFromReq>[0];
}

test('ipFromReq prefers req.ip and ignores X-Forwarded-For', () => {
  const req = fakeReq({
    ip: '203.0.113.7',
    socket: { remoteAddress: '10.0.0.2' },
    headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7' },
  });
  assert.equal(ipFromReq(req), '203.0.113.7');
});

test('ipFromReq falls back to socket.remoteAddress, then unknown', () => {
  assert.equal(
    ipFromReq(fakeReq({ ip: undefined, socket: { remoteAddress: '10.0.0.9' } })),
    '10.0.0.9',
  );
  assert.equal(ipFromReq(fakeReq({ ip: undefined, socket: {} })), 'unknown');
  assert.equal(ipFromReq(fakeReq({ ip: '', socket: undefined })), 'unknown');
});

test('under trust proxy: 1, spoofed leftmost XFF entries cannot shift the key', async () => {
  const app = express();
  app.set('trust proxy', 1); // matches server/index.ts
  app.get('/probe', (req, res) => {
    res.json({ key: ipFromReq(req) });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    // Simulates: attacker prepends '6.6.6.6', the trusted edge (Railway)
    // appends the real client IP '198.51.100.4' as the last entry.
    const res = await fetch(`http://127.0.0.1:${port}/probe`, {
      headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.4' },
    });
    const body = (await res.json()) as { key: string };
    assert.equal(body.key, '198.51.100.4'); // rightmost (trusted-hop) entry
    assert.notEqual(body.key, '6.6.6.6'); // the old leftmost read returned this

    // No XFF at all → the socket address itself.
    const bare = await fetch(`http://127.0.0.1:${port}/probe`);
    const bareBody = (await bare.json()) as { key: string };
    assert.match(bareBody.key, /^(::ffff:)?127\.0\.0\.1$/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
