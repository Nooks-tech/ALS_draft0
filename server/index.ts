import './loadEnv'; // Must be first - loads .env before routes read process.env

import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { authRouter } from './routes/auth';
import { buildRouter } from './routes/build';
import { foodicsRouter } from './routes/foodics';
import { loyaltyRouter } from './routes/loyalty';
import { ordersRouter } from './routes/orders';
import { otoRouter } from './routes/oto';
import { paymentRouter } from './routes/payment';
import { complaintsRouter } from './routes/complaints';
import { walletPassRouter } from './routes/walletPass';
import { googleWalletRouter } from './routes/googleWallet';
import { supportRouter } from './routes/support';
import { startStaleOrdersCron } from './cron/staleOrders';
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

app.use(cors());
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
app.use('/api/oto', otoRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/complaints', complaintsRouter);
app.use('/api/support', supportRouter);

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`ALS API running on port ${PORT}`);
  startStaleOrdersCron();
  startLoyaltyExpirationCron();
  startComplaintEscalationCron();
});
