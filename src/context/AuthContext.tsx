/**
 * Auth context – phone-based SMS OTP authentication.
 *
 * After the server verifies the OTP it returns Supabase session tokens.
 * We call supabase.auth.setSession() so the existing onAuthStateChange
 * listener picks up the user, and session persistence via AsyncStorage
 * works exactly as before.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../api/supabase';

interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  initialized: boolean;
}

interface AuthContextValue extends AuthState {
  /** Set a Supabase session received from the server after OTP verification. */
  setServerSession: (accessToken: string, refreshToken: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    loading: true,
    initialized: false,
  });

  useEffect(() => {
    if (!supabase) {
      setState({ user: null, session: null, loading: false, initialized: true });
      return;
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({
        user: session?.user ?? null,
        session,
        loading: false,
        initialized: true,
      });
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      setState({
        user: session?.user ?? null,
        session,
        loading: false,
        initialized: true,
      });
    });

    return () => subscription.unsubscribe();
  }, []);

  const setServerSession = useCallback(async (accessToken: string, refreshToken: string) => {
    if (!supabase) return { error: 'Auth not configured. Add Supabase URL and anon key to .env' };
    const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    return { error: error?.message ?? null };
  }, []);

  const signOut = useCallback(async () => {
    if (supabase) await supabase.auth.signOut();
    try {
      const keys = await AsyncStorage.getAllKeys();
      const appKeys = keys.filter((k) => !k.startsWith('supabase.'));
      if (appKeys.length > 0) await AsyncStorage.multiRemove(appKeys);
    } catch {}
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, setServerSession, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
