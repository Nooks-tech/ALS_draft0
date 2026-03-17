-- Wallet pass auto-update tables for Apple Wallet web service
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New Query)

CREATE TABLE IF NOT EXISTS wallet_pass_registrations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  device_library_id text NOT NULL,
  push_token text NOT NULL,
  pass_type_id text NOT NULL,
  serial_number text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(device_library_id, pass_type_id, serial_number)
);

CREATE TABLE IF NOT EXISTS wallet_pass_updates (
  serial_number text PRIMARY KEY,
  last_updated bigint NOT NULL DEFAULT (extract(epoch from now())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_wpr_serial ON wallet_pass_registrations(serial_number);
CREATE INDEX IF NOT EXISTS idx_wpr_device ON wallet_pass_registrations(device_library_id, pass_type_id);
