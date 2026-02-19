/**
 * Saudi phone format: +966 followed by 9 digits (e.g. +966 5XX XXX XXXX)
 */
export const PHONE_PREFIX = '+966';

/** Strip +966 from start to get the editable number part */
export function stripPrefix(phone: string | null | undefined): string {
  if (!phone?.trim()) return '';
  const s = phone.trim().replace(/\s/g, '');
  if (s.startsWith('+966')) return s.slice(4).replace(/\D/g, '');
  if (s.startsWith('966')) return s.slice(3).replace(/\D/g, '');
  return s.replace(/\D/g, '');
}

/** Ensure phone is stored with +966 prefix */
export function ensurePrefix(digits: string): string {
  const d = digits.replace(/\D/g, '');
  if (!d) return '';
  // If they typed 966..., use the rest
  const num = d.startsWith('966') ? d.slice(3) : d;
  return num ? `${PHONE_PREFIX}${num}` : '';
}
