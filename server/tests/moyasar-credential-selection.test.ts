import assert from 'node:assert/strict';
import test from 'node:test';
import { selectActiveMoyasarCredentialPair } from '../lib/moyasarCredentialSelection';

const decrypt = (value: string) => value.replace(/^enc:/, '');

test('sandbox selects a complete canonical pair', () => {
  assert.deepEqual(
    selectActiveMoyasarCredentialPair({
      environment: 'sandbox',
      testPublishableEncrypted: 'enc:pk_test_canonical',
      testSecretEncrypted: 'enc:sk_test_canonical',
      livePublishableEncrypted: 'enc:pk_test_legacy',
      liveSecretEncrypted: 'enc:sk_test_legacy',
      decrypt,
    }),
    {
      publishableKey: 'pk_test_canonical',
      secretKey: 'sk_test_canonical',
    },
  );
});

test('sandbox uses a complete legacy live-slot pair only when canonical slots are absent', () => {
  assert.deepEqual(
    selectActiveMoyasarCredentialPair({
      environment: 'sandbox',
      testPublishableEncrypted: null,
      testSecretEncrypted: null,
      livePublishableEncrypted: 'enc:pk_test_legacy',
      liveSecretEncrypted: 'enc:sk_test_legacy',
      decrypt,
    }),
    {
      publishableKey: 'pk_test_legacy',
      secretKey: 'sk_test_legacy',
    },
  );
});

test('sandbox fails closed instead of mixing a partial canonical pair with legacy slots', () => {
  assert.equal(
    selectActiveMoyasarCredentialPair({
      environment: 'sandbox',
      testPublishableEncrypted: 'enc:pk_test_canonical',
      testSecretEncrypted: null,
      livePublishableEncrypted: 'enc:pk_test_legacy',
      liveSecretEncrypted: 'enc:sk_test_legacy',
      decrypt,
    }),
    null,
  );
  assert.equal(
    selectActiveMoyasarCredentialPair({
      environment: 'sandbox',
      testPublishableEncrypted: null,
      testSecretEncrypted: 'enc:sk_test_canonical',
      livePublishableEncrypted: 'enc:pk_test_legacy',
      liveSecretEncrypted: 'enc:sk_test_legacy',
      decrypt,
    }),
    null,
  );
});

test('production requires a correctly prefixed complete live pair', () => {
  assert.deepEqual(
    selectActiveMoyasarCredentialPair({
      environment: 'production',
      testPublishableEncrypted: 'enc:pk_test_ignored',
      testSecretEncrypted: 'enc:sk_test_ignored',
      livePublishableEncrypted: 'enc:pk_live_canonical',
      liveSecretEncrypted: 'enc:sk_live_canonical',
      decrypt,
    }),
    {
      publishableKey: 'pk_live_canonical',
      secretKey: 'sk_live_canonical',
    },
  );
  assert.equal(
    selectActiveMoyasarCredentialPair({
      environment: 'production',
      testPublishableEncrypted: null,
      testSecretEncrypted: null,
      livePublishableEncrypted: 'enc:pk_live_canonical',
      liveSecretEncrypted: 'enc:sk_test_wrong',
      decrypt,
    }),
    null,
  );
});
