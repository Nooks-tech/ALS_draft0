/**
 * Walk-in profile merge (server-side, ALS Express).
 *
 * Mirror of nooksweb/lib/walk-in-merge.ts. Lives here so the OTP
 * verify path can run it inline after a new Supabase auth user is
 * created or signed in, without a cross-service HTTP hop.
 *
 * When a customer signs in for the first time on the Nooks app, we
 * look across ALL merchants for loyalty_member_profiles rows whose
 * phone_number matches and customer_id IS NULL — those rows were
 * created by the iPad kiosk for walk-in claims. We rewrite their
 * customer_id to the new auth user's UUID, and re-attach any
 * loyalty_transactions / loyalty_points the kiosk already wrote.
 *
 * Fire-and-forget from the caller — never throw.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

function normaliseSaudiPhone(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let digits = raw.replace(/\D+/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('966')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (!/^5\d{8}$/.test(digits)) return null;
  return `+966${digits}`;
}

export async function mergeWalkInProfiles(
  supabase: SupabaseClient,
  authUserId: string,
  phoneRaw: string,
): Promise<{ merged: number; merchantIds: string[] }> {
  const phone = normaliseSaudiPhone(phoneRaw);
  if (!phone || !authUserId) return { merged: 0, merchantIds: [] };

  try {
    const { data: matchingRows, error: selectErr } = await supabase
      .from('loyalty_member_profiles')
      .select('id, merchant_id')
      .eq('phone_number', phone)
      .is('customer_id', null);
    if (selectErr) {
      console.warn('[walk-in-merge] select failed:', selectErr.message);
      return { merged: 0, merchantIds: [] };
    }
    const rows = (matchingRows ?? []) as Array<{ id: string; merchant_id: string }>;
    if (rows.length === 0) return { merged: 0, merchantIds: [] };

    const nowIso = new Date().toISOString();
    const { data: updated, error: updateErr } = await supabase
      .from('loyalty_member_profiles')
      .update({ customer_id: authUserId, updated_at: nowIso })
      .eq('phone_number', phone)
      .is('customer_id', null)
      .select('id, merchant_id');
    if (updateErr) {
      console.warn('[walk-in-merge] update failed:', updateErr.message);
      return { merged: 0, merchantIds: [] };
    }
    const mergedRows = (updated ?? []) as Array<{ id: string; merchant_id: string }>;
    const merchantIds = Array.from(new Set(mergedRows.map((r) => r.merchant_id)));

    await Promise.all(
      mergedRows.map(async (row) => {
        try {
          await supabase
            .from('loyalty_transactions')
            .update({ customer_id: authUserId })
            .eq('merchant_id', row.merchant_id)
            .eq('customer_id', row.id);
        } catch (err) {
          console.warn('[walk-in-merge] tx update failed', row.id, err);
        }
        try {
          const { data: oldPoints } = await supabase
            .from('loyalty_points')
            .select('points, lifetime_points')
            .eq('merchant_id', row.merchant_id)
            .eq('customer_id', row.id)
            .maybeSingle();
          if (!oldPoints) return;
          const { data: existingPoints } = await supabase
            .from('loyalty_points')
            .select('points, lifetime_points')
            .eq('merchant_id', row.merchant_id)
            .eq('customer_id', authUserId)
            .maybeSingle();
          if (existingPoints) {
            await supabase
              .from('loyalty_points')
              .update({
                points:
                  Number((existingPoints as { points?: number }).points ?? 0) +
                  Number((oldPoints as { points?: number }).points ?? 0),
                lifetime_points:
                  Number((existingPoints as { lifetime_points?: number }).lifetime_points ?? 0) +
                  Number((oldPoints as { lifetime_points?: number }).lifetime_points ?? 0),
                updated_at: new Date().toISOString(),
              })
              .eq('merchant_id', row.merchant_id)
              .eq('customer_id', authUserId);
            await supabase
              .from('loyalty_points')
              .delete()
              .eq('merchant_id', row.merchant_id)
              .eq('customer_id', row.id);
          } else {
            await supabase
              .from('loyalty_points')
              .update({ customer_id: authUserId })
              .eq('merchant_id', row.merchant_id)
              .eq('customer_id', row.id);
          }
        } catch (err) {
          console.warn('[walk-in-merge] points migrate failed', row.id, err);
        }
      }),
    );

    await Promise.all(
      merchantIds.map((merchantId) =>
        supabase
          .from('audit_log')
          .insert({
            merchant_id: merchantId,
            user_id: authUserId,
            action: 'loyalty.walkin_merged',
            payload: {
              auth_user_id: authUserId,
              phone,
              profile_ids: mergedRows
                .filter((r) => r.merchant_id === merchantId)
                .map((r) => r.id),
              merged_at: nowIso,
            },
          })
          .then(
            () => {},
            () => {},
          ),
      ),
    );

    console.info('[walk-in-merge] merged', {
      authUserId,
      phoneSuffix: phone.slice(-4),
      merchantCount: merchantIds.length,
      profileCount: mergedRows.length,
    });
    return { merged: mergedRows.length, merchantIds };
  } catch (err) {
    console.warn('[walk-in-merge] unexpected error:', err);
    return { merged: 0, merchantIds: [] };
  }
}
