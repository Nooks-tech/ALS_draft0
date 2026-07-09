import crypto from 'crypto';

/**
 * Merchant credential decryption (ALS side — read/decrypt only; nooksweb's
 * dashboard is the writer).
 *
 * Supported formats (base64url fields), matching nooksweb/lib/merchant-credentials.ts:
 *   v1:{iv}:{tag}:{ciphertext}            — legacy single-key
 *   v2:{keyId}:{iv}:{tag}:{ciphertext}    — key-versioned (rotation-safe)
 *
 * REG-6: nooksweb writes `v2:{keyId}:...` whenever MERCHANT_CREDENTIALS_KEYS is
 * set (a key rotation), but the ALS decryptor previously threw on anything that
 * wasn't `v1`, which would silently break every merchant's checkout the moment
 * keys rotated. This ports nooksweb's exact key-map + v2 decode so both repos
 * stay in lockstep.
 *
 * Key material (identical derivation to nooksweb):
 *   - MERCHANT_CREDENTIALS_KEYS: JSON map {keyId: secret}; each 32-byte AES key
 *     is sha256(secret.trim()). Looked up by the keyId embedded in a v2 blob.
 *   - MERCHANT_CREDENTIALS_ENCRYPTION_KEY: the legacy single secret; its key is
 *     sha256(secret.trim()) and is used for all v1 blobs (stored under the
 *     reserved id "__legacy__").
 */

const ALGORITHM = 'aes-256-gcm';
const FORMAT_V1 = 'v1';
const FORMAT_V2 = 'v2';

const LEGACY_KEY_RAW = (process.env.MERCHANT_CREDENTIALS_ENCRYPTION_KEY ?? '').trim();

type KeyMap = Record<string, Buffer>;

let cachedKeyMap: KeyMap | null = null;

function loadKeyMap(): KeyMap {
  if (cachedKeyMap) return cachedKeyMap;

  const keys: KeyMap = {};

  // Multi-key map mode (v2 writers): JSON {keyId: secret}. Each key is the
  // sha256 of the trimmed secret, matching nooksweb's derivation exactly.
  const raw = (process.env.MERCHANT_CREDENTIALS_KEYS ?? '').trim();
  if (raw) {
    let parsed: Record<string, string> = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('MERCHANT_CREDENTIALS_KEYS must be valid JSON of {keyId: secret}');
    }
    for (const [id, secret] of Object.entries(parsed)) {
      if (!id || typeof secret !== 'string' || !secret.trim()) continue;
      keys[id] = crypto.createHash('sha256').update(secret.trim()).digest();
    }
  }

  // Always allow the legacy single-key to decrypt v1 rows.
  if (LEGACY_KEY_RAW) {
    keys['__legacy__'] = crypto.createHash('sha256').update(LEGACY_KEY_RAW).digest();
  }

  cachedKeyMap = keys;
  return keys;
}

function toBuffer(value: string) {
  return Buffer.from(value, 'base64url');
}

function decryptWithKey(key: Buffer, ivEncoded: string, tagEncoded: string, cipherEncoded: string) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, toBuffer(ivEncoded));
  decipher.setAuthTag(toBuffer(tagEncoded));
  const plaintext = Buffer.concat([
    decipher.update(toBuffer(cipherEncoded)),
    decipher.final(),
  ]).toString('utf8');
  return plaintext || null;
}

export function hasMerchantCredential(value: string | null | undefined) {
  return Boolean(typeof value === 'string' && value.trim());
}

export function decryptMerchantCredential(value: string | null | undefined) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;

  const parts = raw.split(':');
  const version = parts[0];
  const keys = loadKeyMap();

  if (version === FORMAT_V1) {
    // v1:{iv}:{tag}:{ciphertext}
    if (parts.length !== 4 || !parts[1] || !parts[2] || !parts[3]) {
      throw new Error('Unsupported v1 credential format');
    }
    const key = keys['__legacy__'];
    if (!key) {
      throw new Error('MERCHANT_CREDENTIALS_ENCRYPTION_KEY is not configured');
    }
    return decryptWithKey(key, parts[1], parts[2], parts[3]);
  }

  if (version === FORMAT_V2) {
    // v2:{keyId}:{iv}:{tag}:{ciphertext}
    if (parts.length !== 5 || !parts[1] || !parts[2] || !parts[3] || !parts[4]) {
      throw new Error('Unsupported v2 credential format');
    }
    const keyId = parts[1];
    const key = keys[keyId];
    if (!key) {
      throw new Error(
        `Unknown merchant credential key ID '${keyId}' — add it to MERCHANT_CREDENTIALS_KEYS`,
      );
    }
    return decryptWithKey(key, parts[2], parts[3], parts[4]);
  }

  throw new Error(`Unsupported encrypted merchant credential version: ${version}`);
}
