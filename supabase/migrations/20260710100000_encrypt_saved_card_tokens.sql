-- PRIV-02 (2026-07-10 audit): encrypt customer_saved_cards.token at rest.
--
-- Live check found 4/4 rows storing the raw reusable Moyasar token (`tok_...`)
-- in plaintext — unlike every other payment secret, which is AES-256-GCM under
-- the `v2:` envelope. A DB read (service_role, or a leaked management PAT that
-- bypasses RLS) therefore yields chargeable card tokens. The app now encrypts
-- the token on write and decrypts it on read (server/routes/payment.ts).
--
-- This migration is the SCHEMA half only. It does NOT (and cannot) encrypt the
-- existing rows: the AES key material lives in the API runtime env
-- (MERCHANT_CREDENTIALS_KEYS / MERCHANT_CREDENTIALS_ENCRYPTION_KEY), not in
-- Postgres. The ciphertext backfill runs in app code — see the note at the end.
--
-- ── Why token_hash ──────────────────────────────────────────────────────────
-- The token column becomes an AES-256-GCM ciphertext with a fresh random IV per
-- write, so the same card encrypts to a different value every time. It can no
-- longer serve as the dedup / upsert key. token_hash = sha256(plaintext token)
-- is stable and is the new key the app upserts on
-- (onConflict: 'customer_id,merchant_id,token_hash') and looks up existing cards
-- with. It is a hash of an already-opaque gateway token (not PAN / PII), so a
-- plaintext hash column carries no card data.
--
-- ── Deploy order (all of these must land together) ──────────────────────────
--   1. Run THIS migration first (adds token_hash + the new unique index; leaves
--      the existing plaintext rows fully working).
--   2. Deploy the API. The encrypt-on-write / decrypt-on-read change is in
--      server/routes/payment.ts, BUT two other files also read the token
--      verbatim and MUST get the same decrypt wrapper or they break on
--      encrypted rows:
--         - server/cron/savedCardSweep.ts (~:61) — probes Moyasar with the raw
--           token; an encrypted value 404s and the sweep then DELETES the card.
--         - server/routes/wallet.ts (~:349-370, /wallet/topup-with-saved-card) —
--           charges the raw token; an encrypted value fails the charge.
--      (Both tolerate legacy plaintext during transition — they should reuse the
--      same envelope-prefix check the app decryptor uses.)
--   3. Run the one-time ciphertext backfill (below) to remove plaintext at rest.

-- pgcrypto (Supabase installs it in the `extensions` schema) provides digest()
-- for hashing the existing plaintext tokens below.
create extension if not exists pgcrypto with schema extensions;

alter table public.customer_saved_cards
  add column if not exists token_hash text;

-- Backfill token_hash for the existing PLAINTEXT rows. Safe to run now: the
-- token is still plaintext at this point, so sha256(token) equals the value the
-- app computes from the decrypted token after encryption. (Rows written by the
-- new app code between step 1 and step 3 already carry their own token_hash.)
update public.customer_saved_cards
   set token_hash = encode(extensions.digest(token, 'sha256'), 'hex')
 where token_hash is null;

-- New dedup key. Partial (WHERE token_hash IS NOT NULL) so any transient
-- pre-backfill null can't trip the unique constraint.
create unique index if not exists customer_saved_cards_customer_merchant_token_hash_key
  on public.customer_saved_cards (customer_id, merchant_id, token_hash)
  where token_hash is not null;

-- The old uniqueness was on the (now-encrypted, high-entropy) token column: it
-- can never collide again and no longer reflects card identity, and the app's
-- upsert onConflict target moves to the token_hash index above. Drop it. IF
-- EXISTS makes this a no-op if the auto-generated constraint name differs in
-- your environment (the CREATE TABLE used an inline UNIQUE(customer_id,
-- merchant_id, token), which Postgres names <table>_<cols>_key by default).
alter table public.customer_saved_cards
  drop constraint if exists customer_saved_cards_customer_id_merchant_id_token_key;

-- ── One-time ciphertext backfill — RUN IN APP CODE, not in this migration ────
-- The 4 legacy rows stay plaintext until re-encrypted. Every read path tolerates
-- plaintext during the transition (it checks for the `v1:`/`v2:` envelope prefix
-- and passes the value through untouched otherwise), so nothing breaks if this
-- backfill is deferred — but plaintext-at-rest is not eliminated until it runs.
--
-- Run a one-off Node script inside the API runtime (it has the key). Pseudocode:
--
--   import { encryptSavedCardToken, savedCardTokenHash }
--     from './server/routes/payment';   // or a shared util once extracted
--
--   const { data: rows } = await supabaseAdmin
--     .from('customer_saved_cards')
--     .select('id, token')
--     .not('token', 'like', 'v1:%')
--     .not('token', 'like', 'v2:%');
--   for (const row of rows ?? []) {
--     await supabaseAdmin
--       .from('customer_saved_cards')
--       .update({
--         token: encryptSavedCardToken(row.token),
--         token_hash: savedCardTokenHash(row.token),
--       })
--       .eq('id', row.id);
--   }
--
-- Post-condition invariant (expect 0):
--   select count(*) from public.customer_saved_cards
--    where token not like 'v1:%' and token not like 'v2:%';
