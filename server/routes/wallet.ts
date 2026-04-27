/**
 * Customer wallet (per-merchant balance + history).
 *
 * Customers use the wallet for two distinct flows:
 *   1. **Top-up** — they pay Moyasar to load credit into the wallet.
 *      The metadata.type='wallet_topup' marker on the Moyasar payment is
 *      what the finalize endpoint uses to (a) tell wallet-bound payments
 *      apart from regular orders and (b) prevent duplicate crediting if
 *      the mobile app calls finalize twice for the same payment id.
 *   2. **Spend** — wallet is offered as a payment method at checkout
 *      when the customer has enough balance for the order. The order
 *      commit endpoint (server/routes/orders.ts) calls debitWallet
 *      below before shipping the Foodics order, returning the same 400
 *      shape the regular insufficient-funds path uses so the mobile app
 *      can fall back to card.
 *
 * Refunds come in via server/routes/complaints.ts when the merchant
 * approves a complaint — a wallet credit replaces the old Moyasar
 * card refund, which took 5-10 days and bled refund fees.
 *
 * All amounts in halalas (1 SAR = 100 halalas) for integer math; the
 * mobile app and dashboard see SAR.
 */
import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuthenticatedAppUser } from '../utils/appUserAuth';
import { paymentService } from '../services/payment';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

export const walletRouter = Router();

const TOPUP_MIN_SAR = 5;
const TOPUP_MAX_SAR = 5000;

function sarToHalalas(amount: number): number {
  return Math.round(amount * 100);
}

function halalasToSar(halalas: number): number {
  return Math.round(halalas) / 100;
}

/** Helper that maps a halalas balance row + entries shape to SAR for the client. */
function shapeBalance(
  balanceRow:
    | {
        balance_halalas: number | null;
        total_topup_halalas: number | null;
        total_spent_halalas: number | null;
        total_refunded_halalas: number | null;
      }
    | null
    | undefined,
) {
  return {
    balance_sar: halalasToSar(Number(balanceRow?.balance_halalas ?? 0)),
    total_topup_sar: halalasToSar(Number(balanceRow?.total_topup_halalas ?? 0)),
    total_spent_sar: halalasToSar(Number(balanceRow?.total_spent_halalas ?? 0)),
    total_refunded_sar: halalasToSar(Number(balanceRow?.total_refunded_halalas ?? 0)),
  };
}

/**
 * GET /api/wallet/balance?merchantId=...
 * Returns the customer's current balance + last 50 ledger entries for
 * the (customer, merchant) pair, all in SAR for the client.
 */
walletRouter.get('/balance', async (req: Request, res: Response) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

    const merchantId = String(req.query.merchantId ?? '').trim();
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });

    const [{ data: balance }, { data: entries }] = await Promise.all([
      supabaseAdmin
        .from('customer_wallet_balances')
        .select('balance_halalas, total_topup_halalas, total_spent_halalas, total_refunded_halalas')
        .eq('customer_id', user.id)
        .eq('merchant_id', merchantId)
        .maybeSingle(),
      supabaseAdmin
        .from('customer_wallet_transactions')
        .select('id, entry_type, amount_halalas, balance_after_halalas, order_id, payment_id, complaint_id, note, created_at')
        .eq('customer_id', user.id)
        .eq('merchant_id', merchantId)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    res.json({
      ...shapeBalance(balance),
      entries: (entries ?? []).map((e: any) => ({
        id: e.id,
        entry_type: e.entry_type,
        amount_sar: halalasToSar(e.amount_halalas),
        balance_after_sar: halalasToSar(e.balance_after_halalas),
        order_id: e.order_id,
        payment_id: e.payment_id,
        complaint_id: e.complaint_id,
        note: e.note,
        created_at: e.created_at,
      })),
    });
  } catch (err: any) {
    console.error('[Wallet] balance error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to load wallet balance' });
  }
});

/**
 * POST /api/wallet/topup-initiate
 * body: { amount_sar: number, merchantId: string, customer?, successUrl? }
 *
 * Creates a Moyasar payment whose metadata flags it as a wallet topup.
 * The customer pays Moyasar normally; the mobile app then calls
 * /topup-finalize with the payment id to credit the wallet.
 */
walletRouter.post('/topup-initiate', async (req: Request, res: Response) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    const { amount_sar, merchantId, customer, successUrl } = req.body ?? {};
    const merchantIdStr = String(merchantId ?? '').trim();
    const amountNum = Number(amount_sar);

    if (!merchantIdStr) {
      return res.status(400).json({ error: 'merchantId required' });
    }
    if (!Number.isFinite(amountNum) || amountNum < TOPUP_MIN_SAR || amountNum > TOPUP_MAX_SAR) {
      return res.status(400).json({
        error: `Top-up amount must be between ${TOPUP_MIN_SAR} and ${TOPUP_MAX_SAR} SAR`,
      });
    }

    const session = await paymentService.initiatePayment({
      amount: amountNum,
      currency: 'SAR',
      // Synthetic order id so Moyasar has something unique. Prefixed
      // 'wallet-' to make it obvious in the Moyasar dashboard that this
      // payment isn't tied to a customer order.
      orderId: `wallet-${user.id}-${Date.now()}`,
      customer,
      successUrl,
      merchantId: merchantIdStr,
      metadata: {
        type: 'wallet_topup',
        merchant_id: merchantIdStr,
        customer_id: user.id,
      },
    });

    res.json(session);
  } catch (err: any) {
    console.error('[Wallet] topup-initiate error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to start top-up' });
  }
});

/**
 * POST /api/wallet/topup-finalize
 * body: { paymentId: string, merchantId: string }
 *
 * Verifies the Moyasar payment is paid + tagged as a wallet topup, then
 * idempotently credits the wallet. Idempotency comes from the unique
 * (customer_id, merchant_id, payment_id) check on the transactions
 * table — calling finalize twice for the same payment is a no-op.
 */
walletRouter.post('/topup-finalize', async (req: Request, res: Response) => {
  try {
    const user = await requireAuthenticatedAppUser(req, res);
    if (!user) return;
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

    const { paymentId, merchantId } = req.body ?? {};
    const paymentIdStr = String(paymentId ?? '').trim();
    const merchantIdStr = String(merchantId ?? '').trim();
    if (!paymentIdStr || !merchantIdStr) {
      return res.status(400).json({ error: 'paymentId + merchantId required' });
    }

    // Idempotency: bail out (and return current balance) if we already
    // credited this payment id.
    const { data: existing } = await supabaseAdmin
      .from('customer_wallet_transactions')
      .select('id, balance_after_halalas')
      .eq('customer_id', user.id)
      .eq('merchant_id', merchantIdStr)
      .eq('payment_id', paymentIdStr)
      .eq('entry_type', 'topup')
      .maybeSingle();
    if (existing) {
      const { data: balance } = await supabaseAdmin
        .from('customer_wallet_balances')
        .select('balance_halalas, total_topup_halalas, total_spent_halalas, total_refunded_halalas')
        .eq('customer_id', user.id)
        .eq('merchant_id', merchantIdStr)
        .maybeSingle();
      return res.json({
        success: true,
        already_credited: true,
        ...shapeBalance(balance),
      });
    }

    // Verify the Moyasar payment server-side. Never trust the mobile
    // app's claim that "this payment is paid" — they could send any id.
    const secretKey = process.env.MOYASAR_SECRET_KEY;
    if (!secretKey) {
      // Some merchants run their own secret key; the per-merchant config
      // resolution lives in services/payment.ts. For wallet topups we
      // accept either: env-level or a future per-merchant lookup.
      return res.status(503).json({ error: 'MOYASAR_SECRET_KEY not configured for wallet finalize' });
    }
    const authHeader = `Basic ${Buffer.from(secretKey + ':').toString('base64')}`;
    const moyasarRes = await fetch(`https://api.moyasar.com/v1/payments/${encodeURIComponent(paymentIdStr)}`, {
      headers: { Authorization: authHeader },
    });
    if (!moyasarRes.ok) {
      const text = await moyasarRes.text().catch(() => '');
      return res.status(502).json({ error: `Moyasar lookup failed (${moyasarRes.status}): ${text.slice(0, 200)}` });
    }
    const payment: any = await moyasarRes.json();
    if (payment?.status !== 'paid') {
      return res.status(400).json({
        error: `Payment status is ${payment?.status ?? 'unknown'} — only "paid" payments can credit the wallet.`,
      });
    }

    // Verify the metadata says wallet_topup AND the customer + merchant
    // match — defends against someone replaying another customer's
    // payment id to credit their own wallet.
    const meta = payment?.metadata ?? {};
    if (
      meta.type !== 'wallet_topup' ||
      String(meta.customer_id ?? '') !== user.id ||
      String(meta.merchant_id ?? '') !== merchantIdStr
    ) {
      return res.status(400).json({ error: 'Payment metadata does not match a top-up for this customer / merchant.' });
    }

    const amountHalalas = Number(payment.amount);
    if (!Number.isFinite(amountHalalas) || amountHalalas <= 0) {
      return res.status(400).json({ error: 'Payment amount missing or invalid.' });
    }

    const { data: rpcRows, error: rpcError } = await supabaseAdmin.rpc('credit_customer_wallet', {
      p_customer_id: user.id,
      p_merchant_id: merchantIdStr,
      p_amount_halalas: amountHalalas,
      p_entry_type: 'topup',
      p_payment_id: paymentIdStr,
      p_note: `Top-up via Moyasar (${payment.source?.type ?? 'card'})`,
    });
    if (rpcError) {
      return res.status(500).json({ error: `Wallet credit failed: ${rpcError.message}` });
    }

    const newBalanceHalalas = Number((rpcRows as any)?.[0]?.new_balance_halalas ?? 0);
    res.json({
      success: true,
      already_credited: false,
      credited_sar: halalasToSar(amountHalalas),
      balance_sar: halalasToSar(newBalanceHalalas),
    });
  } catch (err: any) {
    console.error('[Wallet] topup-finalize error:', err?.message);
    res.status(500).json({ error: err?.message || 'Failed to finalize top-up' });
  }
});

/**
 * Internal helper used by the order commit path. NOT exposed as a
 * route — never trust client claims about wallet debits. Throws on
 * failure with the literal 'INSUFFICIENT_WALLET_BALANCE' message
 * so callers can surface the right shape to the mobile app.
 */
export async function debitWalletForOrder(params: {
  customerId: string;
  merchantId: string;
  amountSar: number;
  orderId: string;
}): Promise<{ newBalanceSar: number; transactionId: string }> {
  if (!supabaseAdmin) throw new Error('Database not configured');
  const amountHalalas = sarToHalalas(params.amountSar);
  if (amountHalalas <= 0) {
    throw new Error('Wallet debit amount must be positive');
  }

  const { data: rpcRows, error } = await supabaseAdmin.rpc('debit_customer_wallet', {
    p_customer_id: params.customerId,
    p_merchant_id: params.merchantId,
    p_amount_halalas: amountHalalas,
    p_order_id: params.orderId,
    p_note: null,
  });

  if (error) {
    if (typeof error.message === 'string' && error.message.includes('INSUFFICIENT_WALLET_BALANCE')) {
      throw new Error('INSUFFICIENT_WALLET_BALANCE');
    }
    throw new Error(error.message);
  }

  const row = (rpcRows as any)?.[0];
  return {
    newBalanceSar: halalasToSar(Number(row?.new_balance_halalas ?? 0)),
    transactionId: String(row?.transaction_id ?? ''),
  };
}

/**
 * Internal helper used by the complaint resolve path to credit a
 * refund into the wallet. Replaces the prior Moyasar card refund.
 */
export async function creditWalletForRefund(params: {
  customerId: string;
  merchantId: string;
  amountSar: number;
  orderId: string;
  complaintId: string;
  note?: string;
}): Promise<{ newBalanceSar: number; transactionId: string }> {
  if (!supabaseAdmin) throw new Error('Database not configured');
  const amountHalalas = sarToHalalas(params.amountSar);
  if (amountHalalas <= 0) {
    throw new Error('Refund amount must be positive');
  }

  const { data: rpcRows, error } = await supabaseAdmin.rpc('credit_customer_wallet', {
    p_customer_id: params.customerId,
    p_merchant_id: params.merchantId,
    p_amount_halalas: amountHalalas,
    p_entry_type: 'refund',
    p_order_id: params.orderId,
    p_complaint_id: params.complaintId,
    p_note: params.note ?? null,
  });
  if (error) throw new Error(error.message);

  const row = (rpcRows as any)?.[0];
  return {
    newBalanceSar: halalasToSar(Number(row?.new_balance_halalas ?? 0)),
    transactionId: String(row?.transaction_id ?? ''),
  };
}
