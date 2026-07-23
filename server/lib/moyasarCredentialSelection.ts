export type MoyasarCredentialPair = {
  publishableKey: string;
  secretKey: string;
};

type SelectActiveCredentialPairArgs = {
  environment: 'sandbox' | 'production';
  testPublishableEncrypted: string | null | undefined;
  testSecretEncrypted: string | null | undefined;
  livePublishableEncrypted: string | null | undefined;
  liveSecretEncrypted: string | null | undefined;
  decrypt: (encrypted: string) => string | null;
};

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

/**
 * Resolve the merchant's Moyasar publishable and secret keys as one unit.
 *
 * Sandbox accepts the historical test-keys-in-live-slots shape only when both
 * canonical test slots are absent. Once either canonical slot is populated,
 * both canonical keys are required. Production uses only a complete live
 * pair. This prevents the API and client from selecting different accounts.
 */
export function selectActiveMoyasarCredentialPair({
  environment,
  testPublishableEncrypted,
  testSecretEncrypted,
  livePublishableEncrypted,
  liveSecretEncrypted,
  decrypt,
}: SelectActiveCredentialPairArgs): MoyasarCredentialPair | null {
  const canonicalTestSlotsPresent =
    environment === 'sandbox' &&
    (present(testPublishableEncrypted) || present(testSecretEncrypted));
  const publishableEncrypted =
    environment === 'sandbox'
      ? canonicalTestSlotsPresent
        ? testPublishableEncrypted
        : livePublishableEncrypted
      : livePublishableEncrypted;
  const secretEncrypted =
    environment === 'sandbox'
      ? canonicalTestSlotsPresent
        ? testSecretEncrypted
        : liveSecretEncrypted
      : liveSecretEncrypted;
  if (!present(publishableEncrypted) || !present(secretEncrypted)) return null;

  let publishableKey: string | null = null;
  let secretKey: string | null = null;
  try {
    publishableKey = decrypt(publishableEncrypted)?.trim() || null;
    secretKey = decrypt(secretEncrypted)?.trim() || null;
  } catch {
    return null;
  }

  const mode = environment === 'sandbox' ? 'test' : 'live';
  if (
    !publishableKey?.startsWith(`pk_${mode}_`) ||
    !secretKey?.startsWith(`sk_${mode}_`)
  ) {
    return null;
  }
  return { publishableKey, secretKey };
}
