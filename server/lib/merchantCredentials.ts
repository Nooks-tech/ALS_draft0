import crypto from 'crypto';

const ENCRYPTION_SECRET = (process.env.MERCHANT_CREDENTIALS_ENCRYPTION_KEY ?? '').trim();
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey() {
  if (!ENCRYPTION_SECRET) {
    throw new Error('MERCHANT_CREDENTIALS_ENCRYPTION_KEY is not configured');
  }
  return crypto.createHash('sha256').update(ENCRYPTION_SECRET).digest();
}

function toBuffer(value: string) {
  return Buffer.from(value, 'base64url');
}

export function hasMerchantCredential(value: string | null | undefined) {
  return Boolean(typeof value === 'string' && value.trim());
}

export function decryptMerchantCredential(value: string | null | undefined) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const [version, ivEncoded, tagEncoded, cipherEncoded] = raw.split(':');
  if (version !== 'v1' || !ivEncoded || !tagEncoded || !cipherEncoded) {
    throw new Error('Unsupported encrypted merchant credential format');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), toBuffer(ivEncoded));
  decipher.setAuthTag(toBuffer(tagEncoded));
  return Buffer.concat([
    decipher.update(toBuffer(cipherEncoded)),
    decipher.final(),
  ]).toString('utf8') || null;
}
