import './loadEnv'; // Must be first - loads .env before routes read process.env
import { validateEnv } from './validateEnv';

validateEnv();

// Sentry must initialize BEFORE express is required so it can hook into
// Node's runtime instrumentation (HTTP, fs, etc.). Reads SENTRY_DSN from
// env — if unset, Sentry.init becomes a no-op so dev / unconfigured
// environments aren't affected. tracesSampleRate=0 disables performance
// tracing (we only want errors at pilot stage; tracing eats free-tier
// quota fast). environment lets us filter prod vs preview in the UI.
import * as Sentry from '@sentry/node';
import { scrubSentryEvent } from './utils/sentryContext';
const SENTRY_DSN = (process.env.SENTRY_DSN ?? '').trim();
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 0,
    environment: process.env.NODE_ENV || 'development',
    // Phase A: scrub secret-bearing headers and body fields before
    // shipping. Without this, request bodies containing OTP codes or
    // headers with Authorization / x-nooks-internal-secret would land
    // in Sentry's cloud verbatim. Cast is safe — scrubSentryEvent
    // accepts the generic Event shape and only touches well-known
    // fields (request, breadcrumbs).
    beforeSend: scrubSentryEvent as unknown as Sentry.NodeOptions['beforeSend'],
  });
}

import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { accountRouter } from './routes/account';
import { authRouter } from './routes/auth';
import { buildRouter } from './routes/build';
import { foodicsRouter } from './routes/foodics';
import { loyaltyRouter } from './routes/loyalty';
import { ordersRouter } from './routes/orders';
import { paymentRouter } from './routes/payment';
import { complaintsRouter } from './routes/complaints';
import { walletRouter } from './routes/wallet';
import { walletPassRouter } from './routes/walletPass';
import { googleWalletRouter } from './routes/googleWallet';
import { supportRouter } from './routes/support';
import { analyticsRouter } from './routes/analytics';
import { profileRouter } from './routes/profile';
import { cartRouter } from './routes/cart';
import { startCartAbandonmentCron } from './cron/cartAbandonment';
import { startLoyaltyExpirationCron } from './cron/loyaltyExpiration';
import { startComplaintEscalationCron } from './cron/complaintEscalation';
import { startSavedCardSweepCron } from './cron/savedCardSweep';

const app = express();
// Railway terminates TLS at its edge and sets X-Forwarded-For before the
// request reaches us. express-rate-limit blows up with ValidationError on
// every request if we don't opt into trusting exactly one hop of proxy.
// A literal `1` is the safest value — trusting a wider chain would let
// callers spoof their IP by injecting forwarded headers themselves.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// Build webhook: warn at startup if env is missing (avoids cryptic 500 on first POST)
const g = process.env.GITHUB_TOKEN;
const r = process.env.GITHUB_REPO;
if (!g || !r) {
  console.warn('[Build] GITHUB_TOKEN or GITHUB_REPO not set – POST /build will return 500 until you set them in server env.');
}

// CORS is locked to an explicit allowlist (plus any Expo dev origin) so
// a malicious site can't CSRF a signed-in mobile user's browser into
// firing payment/cancel requests cross-origin. Set ALLOWED_ORIGINS to
// a comma-separated list in env (e.g. "https://nooks.space,https://
// app.nooks.space"). Requests with no Origin header (native mobile, curl,
// server-to-server) pass through — they can't be CSRF targets.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOW_EXPO_DEV = process.env.NODE_ENV !== 'production';
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      if (ALLOW_EXPO_DEV && /^(https?:\/\/)?(localhost|127\.0\.0\.1|.*\.exp\.direct)(:\d+)?$/.test(origin)) {
        return cb(null, true);
      }
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  }),
);
app.use(express.json());

// Rate limiting for public-facing endpoints
const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' },
});
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment attempts. Please try again shortly.' },
});
app.use('/api/orders/commit', orderLimiter);
app.use('/api/payment/initiate', paymentLimiter);

app.get('/', (_, res) => res.json({ status: 'ok' }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// Phase F: /ready actually checks DB reachability and surfaces cron
// health. Railway's load balancer should be pointed at /ready, not
// /health, so a Supabase outage or a stalled cron flips us out of
// the healthy pool instead of routing traffic to a broken dyno.
app.get('/ready', async (_, res) => {
  const checks: Record<string, unknown> = {};
  let ok = true;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const sb = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
      : null;
    if (!sb) {
      checks.db = { ok: false, reason: 'unconfigured' };
      ok = false;
    } else {
      const { error } = await sb.from('merchants').select('id', { head: true, count: 'exact' }).limit(1);
      if (error) {
        checks.db = { ok: false, reason: 'query-error', error: error.message };
        ok = false;
      } else {
        checks.db = { ok: true };
      }
    }
  } catch (e: any) {
    checks.db = { ok: false, reason: 'threw', error: e?.message };
    ok = false;
  }
  // Cron freshness — query getCronHealth for each cron with a
  // ~2x slack on its expected interval. Crons being stale is
  // informational, not blocking, so we return 200 even when they
  // lag; the merchant dashboard can poll /ready and flag them.
  try {
    const { getCronHealth } = await import('./utils/cronHeartbeat');
    const [cart, loyalty, complaint, savedCard] = await Promise.all([
      getCronHealth('cartAbandonment', 60 * 1000),
      getCronHealth('loyaltyExpiration', 24 * 60 * 60 * 1000),
      getCronHealth('complaintEscalation', 30 * 60 * 1000),
      getCronHealth('savedCardSweep', 6 * 60 * 60 * 1000),
    ]);
    checks.crons = { cartAbandonment: cart, loyaltyExpiration: loyalty, complaintEscalation: complaint, savedCardSweep: savedCard };
  } catch (e: any) {
    checks.crons = { ok: false, error: e?.message };
  }
  // Migration status — same data the dashboard widget displays.
  try {
    const { checkMigrationStatus } = await import('./utils/migrationStatus');
    checks.migrations = await checkMigrationStatus();
  } catch (e: any) {
    checks.migrations = { ok: false, error: e?.message };
  }
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'unready', checks });
});

app.use('/build', buildRouter);
app.use('/api/account', accountRouter);
app.use('/api/auth', authRouter);
app.use('/api/foodics', foodicsRouter);
app.use('/api/loyalty', loyaltyRouter);
app.use('/api/loyalty', walletPassRouter);
app.use('/api/loyalty', googleWalletRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/complaints', complaintsRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/support', supportRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/profile', profileRouter);
app.use('/api/cart', cartRouter);

// Sentry's Express error handler MUST be registered after all routes
// but before any other custom error middleware. It catches every error
// raised inside route handlers, ships it to Sentry with full request
// context (route, headers, body), then re-throws so any subsequent
// error middleware still runs. No-op when SENTRY_DSN isn't set.
if (SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`ALS API running on port ${PORT}`);
  startLoyaltyExpirationCron();
  startComplaintEscalationCron();
  startSavedCardSweepCron();
  startCartAbandonmentCron();
  // Surface migration drift at boot. If the latest applied migration
  // is older than 14 days, this logs a WARN + ships a Sentry alert
  // so a 2026-05-22-style migration gap doesn't go unnoticed.
  import('./utils/migrationStatus').then((m) => void m.logStartupMigrationStatus());
});
