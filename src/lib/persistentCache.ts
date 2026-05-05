/**
 * Tiny typed wrapper around AsyncStorage for "stale-while-revalidate"
 * caching of API responses. Hot screens (offers, loyalty, wallet,
 * Apple Wallet pass) read the cached payload synchronously-on-mount,
 * paint instantly, then fetch fresh data in the background and update.
 *
 * No expiry / TTL on purpose — the consumer is the source of truth for
 * how stale data may be shown. The fresh fetch always overwrites the
 * cached value on success, so a wrong cached value only sticks around
 * until the next successful network response.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export async function readCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, value: T): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // disk full / quota — caching is best-effort, never blocks the UI.
  }
}

export async function clearCache(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * fetch() with a hard timeout so screens never block forever on a
 * stalled network (planes, dead Wi-Fi captive portals). Returns the
 * Response on success; throws on timeout/network error so the caller
 * can fall back to cached data without touching state.
 */
export async function fetchWithTimeout(
  input: RequestInfo,
  init?: RequestInit,
  timeoutMs = 6000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
