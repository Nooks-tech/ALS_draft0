/**
 * Supabase client for promo codes (and future features).
 * Configure EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in .env
 *
 * Auth-session storage is the iOS Keychain / Android Keystore via
 * expo-secure-store. AsyncStorage was readable by anything running as
 * the app user (and writable on Android in some attack scenarios), so
 * the Supabase access + refresh tokens were sitting in plaintext on
 * device. SecureStore encrypts them at rest.
 *
 * SecureStore values are capped at ~2KB per key. A typical Supabase
 * session payload is 1.5–2.4KB depending on JWT claims, so we chunk
 * across multiple keys to stay safely under the limit. There's also a
 * one-time migration on first read: if SecureStore is empty but the
 * legacy AsyncStorage key exists, we copy the value over and wipe the
 * old key. Without this every user on the upgrade would get bounced to
 * the login screen.
 */
import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

const CHUNK_SIZE = 1800; // SecureStore caps at 2048; leave headroom for the chunk-count suffix
const CHUNK_COUNT_SUFFIX = '__chunks';

const secureStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    try {
      const countRaw = await SecureStore.getItemAsync(key + CHUNK_COUNT_SUFFIX);
      if (countRaw) {
        const count = parseInt(countRaw, 10);
        if (!Number.isFinite(count) || count < 1) return null;
        const parts: string[] = [];
        for (let i = 0; i < count; i++) {
          const part = await SecureStore.getItemAsync(`${key}_${i}`);
          if (part === null) return null;
          parts.push(part);
        }
        return parts.join('');
      }
      const single = await SecureStore.getItemAsync(key);
      if (single !== null) return single;

      // One-time migration: pre-upgrade installs kept the session in
      // AsyncStorage. Copy it over to SecureStore on first read, then
      // wipe the AsyncStorage copy so we don't keep a plaintext mirror.
      try {
        const legacy = await AsyncStorage.getItem(key);
        if (legacy) {
          await this.setItem(key, legacy);
          await AsyncStorage.removeItem(key);
          return legacy;
        }
      } catch {
        // AsyncStorage absent on this platform — no migration needed.
      }
      return null;
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    try {
      // Clear any prior chunks first so a smaller new value doesn't
      // leave stale tail-chunks lying around.
      await this.removeItem(key);
      if (value.length <= CHUNK_SIZE) {
        await SecureStore.setItemAsync(key, value);
        return;
      }
      const count = Math.ceil(value.length / CHUNK_SIZE);
      for (let i = 0; i < count; i++) {
        await SecureStore.setItemAsync(`${key}_${i}`, value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
      }
      await SecureStore.setItemAsync(key + CHUNK_COUNT_SUFFIX, String(count));
    } catch {
      // Failing silently here means the user gets logged out next launch
      // — better than crashing on a transient Keychain error.
    }
  },
  async removeItem(key: string): Promise<void> {
    try {
      const countRaw = await SecureStore.getItemAsync(key + CHUNK_COUNT_SUFFIX);
      if (countRaw) {
        const count = parseInt(countRaw, 10);
        if (Number.isFinite(count)) {
          for (let i = 0; i < count; i++) {
            await SecureStore.deleteItemAsync(`${key}_${i}`);
          }
        }
        await SecureStore.deleteItemAsync(key + CHUNK_COUNT_SUFFIX);
      }
      await SecureStore.deleteItemAsync(key);
    } catch {
      // ignore
    }
  },
};

export const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // SecureStore is unavailable in web preview / SSR. Fall back to
        // in-memory storage there so the SDK doesn't throw on import.
        storage: Platform.OS === 'web' ? undefined : secureStorageAdapter,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;
