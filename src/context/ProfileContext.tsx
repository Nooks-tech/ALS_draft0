/**
 * Profile from Supabase (source of truth) - not local storage
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { getProfile, upsertProfile, type ProfileRow } from '../api/profile';

export type ProfileData = {
  fullName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
};

export type ProfileContextType = {
  profile: ProfileData;
  profileLoaded: boolean;
  updateProfile: (data: Partial<ProfileData>) => void;
  saveProfile: (data?: Partial<ProfileData>) => Promise<void>;
  clearProfile: () => Promise<void>;
  refetchProfile: () => Promise<ProfileData | null>;
};

const defaultProfile: ProfileData = {
  fullName: '',
  email: '',
  phone: '',
  dateOfBirth: '',
};

const ProfileContext = createContext<ProfileContextType | undefined>(undefined);

function rowToProfile(row: ProfileRow | null, email: string): ProfileData {
  return {
    fullName: row?.full_name ?? '',
    email: email ?? '',
    phone: row?.phone_number ?? '',
    dateOfBirth: '',
  };
}

export const ProfileProvider = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth();
  const [profile, setProfile] = useState<ProfileData>(defaultProfile);
  const [profileLoaded, setProfileLoaded] = useState(false);

  const fetchProfile = useCallback(async () => {
    if (!user?.id) {
      setProfile(defaultProfile);
      setProfileLoaded(true);
      return;
    }
    try {
      const row = await getProfile(user.id);
      setProfile(rowToProfile(row, user.email ?? ''));
    } catch {
      setProfile(rowToProfile(null, user.email ?? ''));
    } finally {
      setProfileLoaded(true);
    }
  }, [user?.id, user?.email]);

  useEffect(() => {
    if (!user) {
      setProfile(defaultProfile);
      setProfileLoaded(true);
      return;
    }
    setProfileLoaded(false);
    fetchProfile();
  }, [user?.id, fetchProfile]);

  const updateProfile = useCallback((data: Partial<ProfileData>) => {
    setProfile((prev) => ({ ...prev, ...data }));
  }, []);

  const saveProfile = useCallback(
    async (data?: Partial<ProfileData>) => {
      if (!user?.id) throw new Error('Not logged in');
      const toSave = data ? { ...profile, ...data } : profile;
      setProfile(toSave);
      await upsertProfile(user.id, {
        full_name: toSave.fullName || null,
        phone_number: toSave.phone || null,
      });
    },
    [user?.id, profile]
  );

  const clearProfile = useCallback(async () => {
    setProfile(defaultProfile);
  }, []);

  const refetchProfile = useCallback(async (): Promise<ProfileData | null> => {
    setProfileLoaded(false);
    if (!user?.id) return null;
    try {
      const row = await getProfile(user.id);
      const p = rowToProfile(row, user.email ?? '');
      setProfile(p);
      return p;
    } catch {
      setProfile(rowToProfile(null, user.email ?? ''));
      return null;
    } finally {
      setProfileLoaded(true);
    }
  }, [user?.id, user?.email]);

  return (
    <ProfileContext.Provider
      value={{
        profile,
        profileLoaded,
        updateProfile,
        saveProfile,
        clearProfile,
        refetchProfile,
      }}
    >
      {children}
    </ProfileContext.Provider>
  );
};

export const useProfile = () => {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within ProfileProvider');
  return ctx;
};
