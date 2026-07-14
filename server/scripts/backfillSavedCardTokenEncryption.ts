/**
 * PRIV-02 one-time backfill — encrypt legacy plaintext saved-card tokens.
 *
 * Migration 20260710100000_encrypt_saved_card_tokens.sql added token_hash and
 * moved the dedup key, but the pre-existing rows still store the raw Moyasar
 * token in plaintext. Every read path tolerates that (envelope-prefix check +
 * passthrough), so this backfill can run any time AFTER the app code that
 * encrypts-on-write is deployed — but plaintext-at-rest is not eliminated
 * until it runs.
 *
 * IDEMPOTENT: selects only rows whose token does NOT carry a v1:/v2: envelope
 * prefix and re-checks the prefix per row before writing. Running it twice is
 * a no-op the second time. Rows written by the new app code are never touched.
 *
 * REQUIRED ENV (the same env the API runtime uses):
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   MERCHANT_CREDENTIALS_KEYS (+ MERCHANT_CREDENTIALS_ACTIVE_KEY_ID)
 *     or MERCHANT_CREDENTIALS_ENCRYPTION_KEY
 *
 * Run from server/:  npx tsx scripts/backfillSavedCardTokenEncryption.ts
 * Verify after (expect 0):
 *   select count(*) from customer_saved_cards
 *    where token not like 'v1:%' and token not like 'v2:%';
 */
import { createClient } from '@supabase/supabase-js';
import { encryptSavedCardToken, decryptSavedCardToken, savedCardTokenHash } from '../routes/payment';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    process.exit(2);
  }
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: rows, error } = await supabaseAdmin
    .from('customer_saved_cards')
    .select('id, token')
    .not('token', 'like', 'v1:%')
    .not('token', 'like', 'v2:%');
  if (error) {
    console.error('Select failed:', error.message);
    process.exit(1);
  }

  let encrypted = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows ?? []) {
    const token = typeof row.token === 'string' ? row.token.trim() : '';
    // Belt-and-braces idempotency re-check (a concurrent writer or a prior
    // partial run may have encrypted this row between select and update).
    if (!token || token.startsWith('v1:') || token.startsWith('v2:')) {
      skipped += 1;
      continue;
    }
    try {
      const stored = encryptSavedCardToken(token);
      // Sanity: the ciphertext must decrypt back to the exact plaintext
      // BEFORE we overwrite the only copy of the token.
      if (decryptSavedCardToken(stored) !== token) {
        throw new Error('roundtrip mismatch — refusing to overwrite');
      }
      const { error: updateError } = await supabaseAdmin
        .from('customer_saved_cards')
        .update({ token: stored, token_hash: savedCardTokenHash(token) })
        .eq('id', row.id)
        // Guard the overwrite on the token still being the plaintext we read
        // (no lost-update if the app re-upserted this row mid-backfill).
        .eq('token', row.token);
      if (updateError) throw new Error(updateError.message);
      encrypted += 1;
      console.log(`[backfill] encrypted card ${row.id}`);
    } catch (err: any) {
      failed += 1;
      console.error(`[backfill] FAILED card ${row.id}:`, err?.message);
    }
  }

  const { count: total } = await supabaseAdmin
    .from('customer_saved_cards')
    .select('id', { count: 'exact', head: true });
  const { count: stillPlain } = await supabaseAdmin
    .from('customer_saved_cards')
    .select('id', { count: 'exact', head: true })
    .not('token', 'like', 'v1:%')
    .not('token', 'like', 'v2:%');

  console.log(
    `[backfill] done: encrypted=${encrypted} skipped=${skipped} failed=${failed} | ` +
      `post-check: total=${total ?? '?'} still_plaintext=${stillPlain ?? '?'} (expect 0)`,
  );
  process.exit(failed > 0 || (stillPlain ?? 0) > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfill] fatal:', err?.message);
  process.exit(1);
});
