/**
 * API client - handles all HTTP requests to ALS backend with auth and timeout
 */
import { API_URL } from './config';
import { supabase } from './supabase';

const REQUEST_TIMEOUT_MS = 15_000;

async function getAuthToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token ?? null;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_URL}${path}`;
  const token = await getAuthToken();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options?.headers,
      },
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const msg = data?.error || data?.message || `Request failed ${res.status}`;
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }

    return data as T;
  } finally {
    clearTimeout(timeout);
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: object) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
};
