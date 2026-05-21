-- OTP-per-merchant + 6-month verification TTL.
--
-- Pre-fix, sms_otp keyed only on (phone, code). The same OTP-confirmed
-- session let the customer sign in at ANY merchant once Supabase auth
-- had their phone verified. In the white-label model where the same
-- human running merchant A's app and merchant B's app should be
-- treated as two separate experiences, that's wrong: each merchant
-- should force the customer through OTP independently, and again
-- after 6 months of inactivity at that merchant.
--
-- Fix:
-- (1) sms_otp gets a merchant_id column. send-otp persists it,
--     verify-otp requires the same merchant_id on lookup.
-- (2) merchant_customers (Phase 6 enrollment table) gets a verified_at
--     column. verify-otp stamps it on success. A 6-month-old
--     verified_at is treated as expired and the customer is re-OTP'd
--     on next interaction at that merchant.
-- (3) For existing customers (verified_at NULL), we backfill from
--     merchant_customers.enrolled_at so anyone enrolled in the last
--     6 months stays signed in. Older enrollments will re-OTP on
--     their next interaction.

ALTER TABLE public.sms_otp
  ADD COLUMN IF NOT EXISTS merchant_id uuid REFERENCES public.merchants(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_sms_otp_phone_merchant
  ON public.sms_otp (phone, merchant_id);

-- merchant_customers gets the verification timestamp + device id.
-- verified_device_id is optional — a future "remember this device"
-- check could compare it against the current device's id to decide
-- whether to re-OTP earlier than the 6-month window.
ALTER TABLE public.merchant_customers
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_device_id text;

-- Backfill: treat existing enrollments as verified at enrollment time.
-- Means existing customers within the 6-month window keep their
-- session; older ones will re-OTP on next action. Safer than nuking
-- everyone's session on deploy.
UPDATE public.merchant_customers
SET verified_at = enrolled_at
WHERE verified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_merchant_customers_verified
  ON public.merchant_customers (merchant_id, customer_id, verified_at);
