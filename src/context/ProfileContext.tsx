/**
 * Per-merchant customer profile context.
 *
 * Phase C: the customer's display name, email, language, and avatar
 * now live in customer_merchant_profiles per (merchant, customer).
 * Two merchant apps installed on the same phone show two independent
 * profiles. Previously this context read from the global `profiles`
 * Supabase table and the same name appeared in both apps — a leak
 * the audit identified as the largest white-label hygiene gap.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { useMerchant } from './MerchantContext';
import { getProfile, upsertProfile, type ProfileRow } from '../api/profile';

export type ProfileData = {
  fullName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  language: 'en' | 'ar' | '';
  marketingOptIn: boolean;
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
  language: '',
  marketingOptIn: false,
};

const ProfileContext = createContext<ProfileContextType | undefined>(undefined);

function rowToProfile(row: ProfileRow | null, phone: string): ProfileData {
  return {
    fullName: row?.full_name ?? '',
    // Per-merchant email — the customer typed this at THIS merchant.
    // Different from auth.users.email (synthetic phone@phone.nooks.app).
    email: row?.email ?? '',
    // Phone is identity — global. Comes from auth user, not per-merchant.
    phone,
    dateOfBirth: '',
    language: row?.language ?? '',
    marketingOptIn: row?.marketing_opt_in ?? false,
  };
}

export const ProfileProvider = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth();
  const { merchantId } = useMerchant();
  const [profile, setProfile] = useState<ProfileData>(defaultProfile);
  const [profileLoaded, setProfileLoaded] = useState(false);

  const fetchProfile = useCallback(async () => {
    if (!user?.id || !merchantId) {
      setProfile(defaultProfile);
      setProfileLoaded(true);
      return;
    }
    try {
      const row = await getProfile(merchantId);
      setProfile(rowToProfile(row, user.phone ?? ''));
    } catch {
      setProfile(rowToProfile(null, user.phone ?? ''));
    } finally {
      setProfileLoaded(true);
    }
  }, [user?.id, user?.phone, merchantId]);

  useEffect(() => {
    if (!user) {
      setProfile(defaultProfile);
      setProfileLoaded(true);
      return;
    }
    setProfileLoaded(false);
    fetchProfile();
  }, [user?.id, merchantId, fetchProfile]);

  const updateProfile = useCallback((data: Partial<ProfileData>) => {
    setProfile((prev) => ({ ...prev, ...data }));
  }, []);

  const saveProfile = useCallback(
    async (data?: Partial<ProfileData>) => {
      if (!user?.id) throw new Error('Not logged in');
      if (!merchantId) throw new Error('Merchant context missing');
      const toSave = data ? { ...profile, ...data } : profile;
      setProfile(toSave);
      await upsertProfile(merchantId, {
        full_name: toSave.fullName || null,
        email: toSave.email || null,
        language: toSave.language === 'en' || toSave.language === 'ar' ? toSave.language : null,
        marketing_opt_in: toSave.marketingOptIn,
      });
    },
    [user?.id, merchantId, profile]
  );

  const clearProfile = useCallback(async () => {
    setProfile(defaultProfile);
  }, []);

  const refetchProfile = useCallback(async (): Promise<ProfileData | null> => {
    setProfileLoaded(false);
    if (!user?.id || !merchantId) return null;
    try {
      const row = await getProfile(merchantId);
      const p = rowToProfile(row, user.phone ?? '');
      setProfile(p);
      return p;
    } catch {
      setProfile(rowToProfile(null, user.phone ?? ''));
      return null;
    } finally {
      setProfileLoaded(true);
    }
  }, [user?.id, user?.phone, merchantId]);

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
