/**
 * Per-merchant customer profile — talks to the ALS server's
 * `/api/profile` route, NOT to the global Supabase `profiles` table.
 *
 * Phase C: each merchant's app shows that merchant's own copy of the
 * customer's display data (name, email, language pref, avatar,
 * marketing opt-in). The customer who installs both merchant A's
 * app and merchant B's app sees ZERO data carryover between them —
 * each is a fresh signup experience.
 *
 * The pre-Phase-C signature took (userId, updates) and went straight
 * to the global `profiles` table. Both have changed: callers now pass
 * (merchantId, updates) because the customer's identity is already
 * carried by the JWT in the Authorization header.
 */

import { supabase } from './supabase';

export type ProfileRow = {
  full_name: string | null;
  email: string | null;
  language: 'en' | 'ar' | null;
  avatar_url: string | null;
  marketing_opt_in: boolean;
  updated_at: string | null;
};

export type ProfileUpdate = Partial<Omit<ProfileRow, 'updated_at'>>;

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Fetch the customer's profile at this merchant. Returns null if the
 * server can't be reached or auth is missing; returns a profile with
 * null fields when the customer hasn't filled in their details yet
 * at this merchant (first interaction).
 */
export async function getProfile(merchantId: string): Promise<ProfileRow | null> {
  if (!API_BASE || !merchantId) return null;
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(
      `${API_BASE.replace(/\/$/, '')}/api/profile?merchantId=${encodeURIComponent(merchantId)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as ProfileRow;
  } catch {
    return null;
  }
}

/**
 * Update the customer's profile at this merchant. Pass only the
 * fields you want to change; others preserve their existing value.
 * Returns the updated profile or null on failure.
 */
export async function upsertProfile(
  merchantId: string,
  updates: ProfileUpdate,
): Promise<ProfileRow | null> {
  if (!API_BASE || !merchantId) return null;
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(
      `${API_BASE.replace(/\/$/, '')}/api/profile?merchantId=${encodeURIComponent(merchantId)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as ProfileRow;
  } catch {
    return null;
  }
}
