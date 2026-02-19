import { Router } from 'express';
import { paymentService } from '../services/payment';

export const paymentRouter = Router();

/** Redirect for payment return - allows https success_url that redirects to app deep link */
paymentRouter.get('/redirect', (req, res) => {
  const to = req.query.to as string;
  if (to && (to.startsWith('alsdraft0://') || to.startsWith('https://'))) {
    return res.redirect(302, to);
  }
  res.status(400).send('Invalid redirect');
});

paymentRouter.post('/initiate', async (req, res) => {
  try {
    const { amount, currency, orderId, customer, successUrl } = req.body;
    console.log('[Payment] Initiate request:', { amount, currency, orderId });
    const session = await paymentService.initiatePayment({
      amount: Number(amount),
      currency: currency || 'SAR',
      orderId,
      customer,
      successUrl,
    });
    console.log('[Payment] Session created:', session.id, session.url ? 'has url' : 'no url');
    res.json(session);
  } catch (error: any) {
    console.error('[Payment] Initiate error:', error?.message);
    res.status(500).json({
      error: error?.message || 'Failed to initiate payment',
    });
  }
});
