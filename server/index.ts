import './loadEnv'; // Must be first - loads .env before routes read process.env
import { validateEnv } from './validateEnv';

validateEnv();

import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { authRouter } from './routes/auth';
import { buildRouter } from './routes/build';
import { foodicsRouter } from './routes/foodics';
import { loyaltyRouter } from './routes/loyalty';
import { ordersRouter } from './routes/orders';
import { paymentRouter } from './routes/payment';
import { complaintsRouter } from './routes/complaints';
import { walletPassRouter } from './routes/walletPass';
import { googleWalletRouter } from './routes/googleWallet';
import { supportRouter } from './routes/support';
import { startLoyaltyExpirationCron } from './cron/loyaltyExpiration';
import { startComplaintEscalationCron } from './cron/complaintEscalation';

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

app.use('/build', buildRouter);
app.use('/api/auth', authRouter);
app.use('/api/foodics', foodicsRouter);
app.use('/api/loyalty', loyaltyRouter);
app.use('/api/loyalty', walletPassRouter);
app.use('/api/loyalty', googleWalletRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/complaints', complaintsRouter);
app.use('/api/support', supportRouter);

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`ALS API running on port ${PORT}`);
  startLoyaltyExpirationCron();
  startComplaintEscalationCron();
});
