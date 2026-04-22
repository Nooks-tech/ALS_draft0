/**
 * API client - handles all HTTP requests to ALS backend with auth and timeout.
 *
 * On 401 responses we transparently try refreshing the Supabase session once
 * and retrying. If the refresh fails the session is gone (token revoked,
 * password rotated elsewhere, etc.) — we sign out so the app drops the user
 * to the login screen cleanly instead of leaving them in a stuck state
 * spamming 401s.
 */
import { API_URL } from './config';
import { supabase } from './supabase';

const REQUEST_TIMEOUT_MS = 15_000;

export async function getAuthToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token ?? null;
}

async function tryRefresh(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.auth.refreshSession();
    if (error) {
      await supabase.auth.signOut().catch(() => {});
      return null;
    }
    return data?.session?.access_token ?? null;
  } catch {
    await supabase.auth.signOut().catch(() => {});
    return null;
  }
}

async function doFetch<T>(
  url: string,
  token: string | null,
  options?: RequestInit,
): Promise<{ res: Response; data: T | null }> {
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
    const data = (await res.json().catch(() => null)) as T | null;
    return { res, data };
  } finally {
    clearTimeout(timeout);
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_URL}${path}`;
  let token = await getAuthToken();

  let { res, data } = await doFetch<T>(url, token, options);

  // If the server says the session is unauthorised, refresh once and retry.
  // Subsequent 401s after the retry mean the session is truly gone.
  if (res.status === 401 && token) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      const retry = await doFetch<T>(url, refreshed, options);
      res = retry.res;
      data = retry.data;
    }
  }

  if (!res.ok) {
    const errData = data as { error?: unknown; message?: unknown } | null;
    const msg = errData?.error || errData?.message || `Request failed ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: object) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  delete: <T>(path: string, body?: object) =>
    request<T>(path, body ? { method: 'DELETE', body: JSON.stringify(body) } : { method: 'DELETE' }),
};
