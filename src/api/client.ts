/**
 * API client - handles all HTTP requests to ALS backend
 */
import { API_URL } from './config';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.error || data?.message || `Request failed ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: object) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
};
