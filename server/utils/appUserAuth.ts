import { createClient, type User } from '@supabase/supabase-js';
import type { Request, Response } from 'express';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const authClient = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

function getBearerToken(req: Request): string {
  const raw = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

export async function requireAuthenticatedAppUser(req: Request, res: Response): Promise<User | null> {
  if (!authClient) {
    res.status(500).json({ error: 'Auth is not configured' });
    return null;
  }

  const accessToken = getBearerToken(req);
  if (!accessToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  const { data, error } = await authClient.auth.getUser(accessToken);
  if (error || !data.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  return data.user;
}
