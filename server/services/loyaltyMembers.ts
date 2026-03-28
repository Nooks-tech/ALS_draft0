import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

export type LoyaltyMemberProfile = {
  merchant_id: string;
  customer_id: string;
  member_code: string;
  display_name: string | null;
  phone_number: string | null;
  email: string | null;
  updated_at?: string | null;
};

function normalizeText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeLookupCode(value: string) {
  return value.replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function parseWalletSerial(value: string) {
  const match = value.match(/^loyalty-([0-9a-f-]+)-([0-9a-f-]+)$/i);
  if (!match) return null;
  return {
    merchantId: match[1],
    customerId: match[2],
  };
}

function phoneLookupCandidates(value: string) {
  const digits = value.replace(/\D/g, '');
  const candidates = new Set<string>();
  if (!digits) return [];
  candidates.add(digits);
  candidates.add(`+${digits}`);
  if (digits.startsWith('966')) {
    candidates.add(`+${digits}`);
  } else if (digits.startsWith('0') && digits.length === 10) {
    candidates.add(`966${digits.slice(1)}`);
    candidates.add(`+966${digits.slice(1)}`);
  } else if (digits.length === 9) {
    candidates.add(`966${digits}`);
    candidates.add(`+966${digits}`);
  }
  return [...candidates];
}

async function readCustomerProfile(customerId: string) {
  if (!supabaseAdmin) return { displayName: null, phoneNumber: null, email: null };

  const [profileQuery, authQuery] = await Promise.all([
    supabaseAdmin
      .from('profiles')
      .select('full_name, phone_number')
      .eq('id', customerId)
      .maybeSingle(),
    supabaseAdmin.auth.admin.getUserById(customerId),
  ]);

  const displayName =
    normalizeText(profileQuery.data?.full_name) ||
    normalizeText(authQuery.data.user?.user_metadata?.full_name) ||
    normalizeText(authQuery.data.user?.user_metadata?.name) ||
    null;
  const phoneNumber =
    normalizeText(profileQuery.data?.phone_number) ||
    normalizeText(authQuery.data.user?.phone) ||
    normalizeText(authQuery.data.user?.user_metadata?.phone) ||
    null;
  const email = normalizeText(authQuery.data.user?.email) || null;

  return { displayName, phoneNumber, email };
}

async function createUniqueMemberCode(merchantId: string) {
  if (!supabaseAdmin) throw new Error('Database not configured');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = `NK${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const existing = await supabaseAdmin
      .from('loyalty_member_profiles')
      .select('member_code')
      .eq('merchant_id', merchantId)
      .eq('member_code', code)
      .maybeSingle();
    if (!existing.data) return code;
  }
  throw new Error('Failed to generate a unique loyalty member code');
}

export async function ensureLoyaltyMemberProfile(merchantId: string, customerId: string) {
  if (!supabaseAdmin) throw new Error('Database not configured');
  if (!merchantId || !customerId) throw new Error('merchantId and customerId are required');

  const existing = await supabaseAdmin
    .from('loyalty_member_profiles')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('customer_id', customerId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

  const profileFields = await readCustomerProfile(customerId);

  if (existing.data) {
    const current = existing.data as LoyaltyMemberProfile;
    const nextDisplayName = profileFields.displayName ?? current.display_name ?? null;
    const nextPhoneNumber = profileFields.phoneNumber ?? current.phone_number ?? null;
    const nextEmail = profileFields.email ?? current.email ?? null;
    if (
      nextDisplayName !== current.display_name ||
      nextPhoneNumber !== current.phone_number ||
      nextEmail !== current.email
    ) {
      const { error } = await supabaseAdmin
        .from('loyalty_member_profiles')
        .update({
          display_name: nextDisplayName,
          phone_number: nextPhoneNumber,
          email: nextEmail,
          updated_at: new Date().toISOString(),
        })
        .eq('merchant_id', merchantId)
        .eq('customer_id', customerId);
      if (error) throw new Error(error.message);
      return {
        ...current,
        display_name: nextDisplayName,
        phone_number: nextPhoneNumber,
        email: nextEmail,
      } as LoyaltyMemberProfile;
    }
    return current;
  }

  const memberCode = await createUniqueMemberCode(merchantId);
  const insertPayload = {
    merchant_id: merchantId,
    customer_id: customerId,
    member_code: memberCode,
    display_name: profileFields.displayName,
    phone_number: profileFields.phoneNumber,
    email: profileFields.email,
    updated_at: new Date().toISOString(),
  };
  const inserted = await supabaseAdmin
    .from('loyalty_member_profiles')
    .insert(insertPayload)
    .select('*')
    .single();
  if (inserted.error || !inserted.data) {
    throw new Error(inserted.error?.message || 'Failed to create loyalty member profile');
  }
  return inserted.data as LoyaltyMemberProfile;
}

export async function findLoyaltyMemberByLookup(merchantId: string, lookup: string) {
  if (!supabaseAdmin) throw new Error('Database not configured');
  const rawLookup = normalizeText(lookup);
  if (!rawLookup) return null;

  const parsedSerial = parseWalletSerial(rawLookup);
  if (parsedSerial && parsedSerial.merchantId === merchantId) {
    return ensureLoyaltyMemberProfile(merchantId, parsedSerial.customerId);
  }

  const memberCode = normalizeLookupCode(rawLookup);
  if (memberCode) {
    const codeQuery = await supabaseAdmin
      .from('loyalty_member_profiles')
      .select('*')
      .eq('merchant_id', merchantId)
      .eq('member_code', memberCode)
      .maybeSingle();
    if (codeQuery.error) throw new Error(codeQuery.error.message);
    if (codeQuery.data) return codeQuery.data as LoyaltyMemberProfile;
  }

  const phoneCandidates = phoneLookupCandidates(rawLookup);
  if (phoneCandidates.length > 0) {
    const profileQuery = await supabaseAdmin
      .from('profiles')
      .select('id')
      .in('phone_number', phoneCandidates)
      .limit(1)
      .maybeSingle();
    if (profileQuery.error) throw new Error(profileQuery.error.message);
    if (profileQuery.data?.id) {
      return ensureLoyaltyMemberProfile(merchantId, String(profileQuery.data.id));
    }
  }

  return null;
}
