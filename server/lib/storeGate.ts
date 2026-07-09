/**
 * Branch-level "is the store effectively open" gate for order intake.
 *
 * Mirrors the evaluator nooksweb uses for the public /operations
 * endpoint so the app's closed-state UI and this server-side rejection
 * can never disagree. A branch is EFFECTIVELY CLOSED when any of:
 *   manual         — merchant pressed Close (until they press Open)
 *   busy           — merchant pressed Busy; closed until busy_until
 *                    (legacy rows: busy_started_at + prep_time_minutes)
 *   outside_hours  — now is outside the scheduled window (minute-granular,
 *                    inclusive boundaries, wraps midnight, merchant TZ)
 *
 * Billing (subscription lapsed) is NOT evaluated here — the REG-1 gate
 * in /commit and the payment runtime config already own that.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type StoreGateResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      code: 'BRANCH_INVALID' | 'STORE_CLOSED' | 'ORDER_TYPE_DISABLED';
      error: string;
      closedReason?: 'manual' | 'busy' | 'outside_hours';
      reopensAt?: string | null;
    };

type BranchOpsRow = {
  store_status?: string | null;
  prep_time_minutes?: number | null;
  busy_started_at?: string | null;
  busy_until?: string | null;
  open_from_hour?: number | null;
  open_till_hour?: number | null;
  open_from_minute?: number | null;
  open_till_minute?: number | null;
  delivery_mode?: string | null;
  delivery_enabled?: boolean | null;
  pickup_enabled?: boolean | null;
  drivethru_enabled?: boolean | null;
};

/** Current minute-of-day (0..1439) in the given IANA timezone. */
function minuteOfDayIn(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
}

export async function checkBranchOrderable(
  supabaseAdmin: SupabaseClient,
  opts: { merchantId: string; branchId: string; orderType?: string | null },
): Promise<StoreGateResult> {
  const { merchantId, branchId, orderType } = opts;

  // Branch must exist, belong to this merchant, and be order-enabled.
  // /commit previously accepted any non-empty branchId string — this
  // lookup doubles as that missing integrity check. A QUERY error (DB
  // blip) is not the same as "branch not found": fail OPEN like the
  // other lookups below, so a transient 5xx can't abort a paid
  // checkout with a spurious BRANCH_INVALID.
  const { data: branch, error: branchLookupError } = await supabaseAdmin
    .from('branch_mappings')
    .select('id, nooks_enabled, receives_online_orders')
    .eq('merchant_id', merchantId)
    .eq('id', branchId)
    .maybeSingle();
  if (branchLookupError) {
    console.warn('[StoreGate] branch_mappings lookup failed — failing open:', branchLookupError.message);
  } else if (!branch || branch.nooks_enabled === false || branch.receives_online_orders === false) {
    return {
      ok: false,
      status: 400,
      code: 'BRANCH_INVALID',
      error: 'This branch is not available for ordering.',
    };
  }

  const [{ data: row }, { data: ac }, { data: foodics }] = await Promise.all([
    supabaseAdmin
      .from('branch_operations')
      .select(
        'store_status, prep_time_minutes, busy_started_at, busy_until, open_from_hour, open_till_hour, open_from_minute, open_till_minute, delivery_mode, delivery_enabled, pickup_enabled, drivethru_enabled',
      )
      .eq('merchant_id', merchantId)
      .eq('branch_id', branchId)
      .maybeSingle(),
    supabaseAdmin
      .from('app_config')
      .select('prep_time_minutes')
      .eq('merchant_id', merchantId)
      .maybeSingle(),
    supabaseAdmin
      .from('foodics_connections')
      .select('business_timezone')
      .eq('merchant_id', merchantId)
      .maybeSingle(),
  ]);

  const ops = (row ?? null) as BranchOpsRow | null;
  const timeZone =
    typeof foodics?.business_timezone === 'string' && foodics.business_timezone.trim()
      ? foodics.business_timezone.trim()
      : 'Asia/Riyadh';
  const now = new Date();
  const nowMs = now.getTime();

  let storeStatus: 'open' | 'busy' | 'closed' =
    ops?.store_status === 'busy' || ops?.store_status === 'closed' ? ops.store_status : 'open';

  // Busy: explicit busy_until wins; legacy rows fall back to
  // busy_started_at + prep_time_minutes. Expired busy reads as open
  // (the nooksweb endpoints own the row writeback).
  let busyUntil: string | null = null;
  let busySecondsLeft = 0;
  if (storeStatus === 'busy') {
    let untilMs = NaN;
    if (typeof ops?.busy_until === 'string') {
      untilMs = Date.parse(ops.busy_until);
    } else if (typeof ops?.busy_started_at === 'string') {
      const startedMs = Date.parse(ops.busy_started_at);
      const prepMin = Number(ops?.prep_time_minutes ?? ac?.prep_time_minutes ?? 15);
      if (Number.isFinite(startedMs)) untilMs = startedMs + prepMin * 60_000;
    }
    if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
      storeStatus = 'open';
    } else {
      busyUntil = new Date(untilMs).toISOString();
      busySecondsLeft = Math.max(0, Math.floor((untilMs - nowMs) / 1000));
    }
  }

  // Scheduled hours, minute-granular, boundaries INCLUSIVE: open
  // 07:00→03:00 means 03:00 is still open and 03:01–06:59 is closed.
  const fromHour = typeof ops?.open_from_hour === 'number' ? ops.open_from_hour : null;
  const tillHour = typeof ops?.open_till_hour === 'number' ? ops.open_till_hour : null;
  let outsideHours = false;
  let nextOpenAt: string | null = null;
  if (fromHour !== null && tillHour !== null) {
    const from = fromHour * 60 + (typeof ops?.open_from_minute === 'number' ? ops.open_from_minute : 0);
    const till = tillHour * 60 + (typeof ops?.open_till_minute === 'number' ? ops.open_till_minute : 0);
    const m = minuteOfDayIn(timeZone, now);
    const insideWindow =
      from === till ? true : from < till ? m >= from && m <= till : m >= from || m <= till;
    if (!insideWindow) {
      outsideHours = true;
      nextOpenAt = new Date(nowMs + (((from - m + 1440) % 1440) * 60_000)).toISOString();
    }
  }

  // NOTE: messages make no claim about the payment — the caller knows
  // whether a charge already happened (and voids it if so).
  if (storeStatus === 'closed') {
    return {
      ok: false,
      status: 409,
      code: 'STORE_CLOSED',
      error: 'The store is currently closed.',
      closedReason: 'manual',
      reopensAt: null,
    };
  }
  if (storeStatus === 'busy') {
    const mins = Math.max(1, Math.ceil(busySecondsLeft / 60));
    return {
      ok: false,
      status: 409,
      code: 'STORE_CLOSED',
      error: `The store is temporarily busy — ordering reopens in about ${mins} min.`,
      closedReason: 'busy',
      reopensAt: busyUntil,
    };
  }
  if (outsideHours) {
    return {
      ok: false,
      status: 409,
      code: 'STORE_CLOSED',
      error: 'The store is currently closed (outside working hours).',
      closedReason: 'outside_hours',
      reopensAt: nextOpenAt,
    };
  }

  // Per-order-type enable flags; undefined (pre-migration rows) means
  // enabled, delivery keeps the legacy delivery_mode fallback.
  if (orderType === 'delivery') {
    const legacyAllows = (ops?.delivery_mode ?? 'delivery_and_pickup') !== 'pickup_only';
    const allowed = typeof ops?.delivery_enabled === 'boolean' ? ops.delivery_enabled : legacyAllows;
    if (!allowed) {
      return {
        ok: false,
        status: 409,
        code: 'ORDER_TYPE_DISABLED',
        error: 'Delivery is not available at this branch. Pick another branch or order type.',
      };
    }
  } else if (orderType === 'pickup') {
    if (ops?.pickup_enabled === false) {
      return {
        ok: false,
        status: 409,
        code: 'ORDER_TYPE_DISABLED',
        error: 'In-store pickup is not available at this branch. Pick another branch or order type.',
      };
    }
  } else if (orderType === 'drivethru') {
    if (ops?.drivethru_enabled === false) {
      return {
        ok: false,
        status: 409,
        code: 'ORDER_TYPE_DISABLED',
        error: 'Receive-from-your-car is not available at this branch. Pick another branch or order type.',
      };
    }
  }

  return { ok: true };
}
