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

async function readCustomerProfile(merchantId: string, customerId: string) {
  if (!supabaseAdmin) return { displayName: null, phoneNumber: null, email: null };

  // Phase C: per-merchant profile is the source of truth for display
  // name / email / language. The legacy global `profiles` table held a
  // shared name across all merchants — reading it here would leak the
  // name the customer typed at merchant A into merchant B's loyalty
  // member profile. Now we read from customer_merchant_profiles
  // scoped to (merchant_id, customer_id), and fall back to legacy
  // global profile ONLY for backfilled rows where the per-merchant
  // copy is empty (transitional support; can be removed after the
  // first month of running on per-merchant writes).
  const [merchantProfileQuery, legacyProfileQuery, authQuery] = await Promise.all([
    supabaseAdmin
      .from('customer_merchant_profiles')
      .select('full_name, email')
      .eq('merchant_id', merchantId)
      .eq('customer_id', customerId)
      .maybeSingle(),
    supabaseAdmin
      .from('profiles')
      .select('full_name, phone_number')
      .eq('id', customerId)
      .maybeSingle(),
    supabaseAdmin.auth.admin.getUserById(customerId),
  ]);

  const displayName =
    normalizeText(merchantProfileQuery.data?.full_name) ||
    normalizeText(legacyProfileQuery.data?.full_name) ||
    normalizeText(authQuery.data.user?.user_metadata?.full_name) ||
    normalizeText(authQuery.data.user?.user_metadata?.name) ||
    null;
  // Phone is identity — always read from auth.users or the legacy
  // global `profiles.phone_number`. Not per-merchant.
  const phoneNumber =
    normalizeText(legacyProfileQuery.data?.phone_number) ||
    normalizeText(authQuery.data.user?.phone) ||
    normalizeText(authQuery.data.user?.user_metadata?.phone) ||
    null;
  // Email is per-merchant (each merchant can have a different
  // customer-supplied email). Auth.users.email is the synthetic
  // `phone@phone.nooks.app` form used internally, NOT a customer-
  // typed value — never use it as a display email.
  const email = normalizeText(merchantProfileQuery.data?.email) || null;

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

  const profileFields = await readCustomerProfile(merchantId, customerId);

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

  // Look up the merchant's current loyalty type to set on the new profile
  let merchantLoyaltyType: string | null = null;
  const { data: loyaltyConfig } = await supabaseAdmin
    .from('loyalty_config')
    .select('loyalty_type')
    .eq('merchant_id', merchantId)
    .maybeSingle();
  merchantLoyaltyType = loyaltyConfig?.loyalty_type ?? null;

  const insertPayload = {
    merchant_id: merchantId,
    customer_id: customerId,
    member_code: memberCode,
    display_name: profileFields.displayName,
    phone_number: profileFields.phoneNumber,
    email: profileFields.email,
    updated_at: new Date().toISOString(),
    ...(merchantLoyaltyType ? { active_loyalty_type: merchantLoyaltyType, loyalty_type_set_at: new Date().toISOString() } : {}),
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
    // Phase C audit hardening: phone lookup against the GLOBAL profile
    // table is the one cross-merchant probe we still allow. It exists
    // because the POS clerk needs to find a customer by phone number,
    // and the phone is the only cross-merchant identity we have. To
    // bound the abuse surface:
    //   (1) The caller of findLoyaltyMemberByLookup is already gated
    //       by requireNooksInternalRequest (POS branch endpoints).
    //   (2) The returned auth.uid is immediately re-scoped: the next
    //       call is ensureLoyaltyMemberProfile(merchantId, uid), which
    //       creates a per-merchant member if none exists. The
    //       per-merchant profile starts EMPTY — no name leak from the
    //       customer's other-merchant footprint.
    //   (3) We write an audit_log entry so any anomalous burst of
    //       lookups (e.g. a leaked internal secret being used to
    //       enumerate phones) shows up in the merchant's audit trail.
    const profileQuery = await supabaseAdmin
      .from('profiles')
      .select('id')
      .in('phone_number', phoneCandidates)
      .limit(1)
      .maybeSingle();
    if (profileQuery.error) throw new Error(profileQuery.error.message);
    if (profileQuery.data?.id) {
      // Best-effort audit log — non-fatal if it fails.
      try {
        await supabaseAdmin.from('audit_log').insert({
          merchant_id: merchantId,
          action: 'loyalty.phone_lookup',
          payload: {
            via: 'cross_merchant_identity',
            resolved_customer_id: String(profileQuery.data.id),
            phone_candidates_count: phoneCandidates.length,
          },
        });
      } catch (_e) { /* non-fatal */ }
      return ensureLoyaltyMemberProfile(merchantId, String(profileQuery.data.id));
    }
  }

  return null;
}
