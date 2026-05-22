-- Phase D — cron heartbeat table.
--
-- All four ALS crons (cartAbandonment, loyaltyExpiration,
-- complaintEscalation, savedCardSweep) run in-process via
-- `setInterval` inside the Express dyno. If an unhandled exception
-- ever kills the interval callback, the process stays alive but the
-- cron silently stops firing — there's no external signal.
--
-- This table is the heartbeat. Each cron writes a row at the START
-- of every tick and UPDATEs it on completion. A separate health
-- check can then query `MAX(started_at) WHERE name = ?` and alert
-- if it's older than 2x the cron's expected interval.
--
-- Schema choices:
--   - (name, started_at) PK lets us keep the full run history with
--     no extra dedupe logic. Each insert is a fresh row.
--   - status column distinguishes 'running' (heartbeat row from
--     start), 'completed' (finished without throwing), 'failed'
--     (caught error logged). The cron wrapper writes 'failed' from
--     its outer try/catch.
--   - duration_ms + last_error are best-effort context.
--   - A cleanup cron (or a periodic delete) should trim rows older
--     than 30 days to bound table growth.

CREATE TABLE IF NOT EXISTS public.cron_runs (
  name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  duration_ms integer,
  last_error text,
  payload jsonb,
  PRIMARY KEY (name, started_at)
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_name_started
  ON public.cron_runs (name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_runs_recent_failed
  ON public.cron_runs (started_at DESC)
  WHERE status = 'failed';

ALTER TABLE public.cron_runs ENABLE ROW LEVEL SECURITY;

-- Service-role only. The merchant dashboard reads this via a future
-- /api/dashboard/system/cron-health endpoint that's owner-gated.
-- No customer-facing access.
