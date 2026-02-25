import './loadEnv'; // Must be first - loads .env before routes read process.env

import cors from 'cors';
import express from 'express';
import { authRouter } from './routes/auth';
import { buildRouter } from './routes/build';
import { foodicsRouter } from './routes/foodics';
import { loyaltyRouter } from './routes/loyalty';
import { ordersRouter } from './routes/orders';
import { otoRouter } from './routes/oto';
import { paymentRouter } from './routes/payment';

const app = express();
const PORT = process.env.PORT || 3001;

// Build webhook: warn at startup if env is missing (avoids cryptic 500 on first POST)
const g = process.env.GITHUB_TOKEN;
const r = process.env.GITHUB_REPO;
if (!g || !r) {
  console.warn('[Build] GITHUB_TOKEN or GITHUB_REPO not set – POST /build will return 500 until you set them in server env.');
}

app.use(cors());
app.use(express.json());

app.get('/', (_, res) => res.json({ status: 'ok' }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.use('/build', buildRouter);
app.use('/api/auth', authRouter);
app.use('/api/foodics', foodicsRouter);
app.use('/api/loyalty', loyaltyRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/oto', otoRouter);
app.use('/api/payment', paymentRouter);

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`ALS API running on port ${PORT}`);
});
