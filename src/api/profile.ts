/**
 * Profile API - Supabase profiles table (source of truth for name, phone)
 */
import { supabase } from './supabase';

export interface ProfileRow {
  id: string;
  full_name: string | null;
  phone_number: string | null;
  avatar_url: string | null;
  updated_at: string | null;
}

export async function getProfile(userId: string): Promise<ProfileRow | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertProfile(
  userId: string,
  updates: { full_name?: string; phone_number?: string; avatar_url?: string }
): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.from('profiles').upsert(
    {
      id: userId,
      ...updates,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) throw error;
}
