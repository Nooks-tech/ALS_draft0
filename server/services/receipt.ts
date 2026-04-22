/**
 * Customer-facing receipt email. Fires after a successful order + payment
 * so the customer has a tax-compliant record (Saudi VAT = 15%). Stores a
 * copy in audit_log for ZATCA e-invoicing record-keeping.
 *
 * Non-fatal: if RESEND_API_KEY or customer email is missing, we skip
 * silently. The customer can also export their full order history from
 * /api/account/export so no data is lost — this is a convenience.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const RESEND_FROM = (process.env.RESEND_FROM_EMAIL || 'receipts@nooks.space').trim();

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

function fmtSar(n: number): string {
  return n.toFixed(2) + ' SAR';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

type ReceiptInput = {
  orderId: string;
  merchantId: string;
  customerEmail: string | null;
  customerName?: string | null;
  totalSar: number;
  deliveryFeeSar?: number | null;
  items: Array<{ name: string; quantity: number; price_sar: number }>;
  orderType: 'delivery' | 'pickup';
  branchName?: string | null;
  paymentMethod?: string | null;
  paymentId?: string | null;
  issuedAt?: string;
};

export async function sendOrderReceipt(input: ReceiptInput): Promise<void> {
  if (!RESEND_API_KEY || !input.customerEmail) return;

  // Saudi VAT = 15% inclusive. Reverse-engineer the taxable base from
  // the grand total so the line item + VAT sum matches exactly.
  const grand = Number(input.totalSar || 0);
  const vatRate = 0.15;
  const base = +(grand / (1 + vatRate)).toFixed(2);
  const vat = +(grand - base).toFixed(2);
  const issued = input.issuedAt ?? new Date().toISOString();

  const rows = input.items
    .map(
      (i) => `
    <tr>
      <td style="padding:6px 0;color:#111">${escapeHtml(i.name)} × ${i.quantity}</td>
      <td style="padding:6px 0;text-align:right;color:#111">${fmtSar(i.price_sar * i.quantity)}</td>
    </tr>`,
    )
    .join('');

  const html = `
  <!doctype html>
  <html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
    <h2 style="margin:0 0 4px">Receipt for your order</h2>
    <p style="margin:0 0 16px;color:#555">${escapeHtml(input.branchName ?? 'Nooks')} · ${new Date(issued).toLocaleString('en-GB')}</p>
    <p style="margin:0 0 16px;color:#555">Order <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px">${escapeHtml(input.orderId)}</code> · ${input.orderType === 'delivery' ? 'Delivery' : 'Pickup'}</p>

    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;border-top:1px solid #e5e7eb">
      ${rows}
      ${input.deliveryFeeSar && input.deliveryFeeSar > 0 ? `<tr><td style="padding:6px 0;color:#555">Delivery</td><td style="padding:6px 0;text-align:right;color:#555">${fmtSar(input.deliveryFeeSar)}</td></tr>` : ''}
    </table>

    <table style="width:100%;border-top:1px solid #e5e7eb;padding-top:8px">
      <tr><td style="padding:4px 0;color:#555">Subtotal (excl. VAT)</td><td style="padding:4px 0;text-align:right;color:#555">${fmtSar(base)}</td></tr>
      <tr><td style="padding:4px 0;color:#555">VAT (15%)</td><td style="padding:4px 0;text-align:right;color:#555">${fmtSar(vat)}</td></tr>
      <tr><td style="padding:8px 0;font-weight:700;border-top:1px solid #e5e7eb">Total</td><td style="padding:8px 0;font-weight:700;text-align:right;border-top:1px solid #e5e7eb">${fmtSar(grand)}</td></tr>
    </table>

    <p style="margin:20px 0 0;color:#6b7280;font-size:12px">Payment: ${escapeHtml(input.paymentMethod ?? 'Card')}${input.paymentId ? ` · ref ${escapeHtml(input.paymentId)}` : ''}</p>
    <p style="margin:4px 0 0;color:#6b7280;font-size:12px">Thank you for ordering with Nooks.</p>
  </body></html>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [input.customerEmail],
        subject: `Nooks receipt — ${fmtSar(grand)} · ${input.orderId.slice(0, 8)}`,
        html,
      }),
    });
  } catch (err: any) {
    console.warn('[receipt] email send failed:', err?.message);
  }

  // Record for ZATCA-style retention. We don't store the rendered HTML
  // (it's reconstructable from the order row) but keep an entry so
  // compliance queries can enumerate issued receipts.
  if (supabaseAdmin) {
    try {
      await supabaseAdmin.from('audit_log').insert({
        merchant_id: input.merchantId,
        action: 'order.receipt_sent',
        payload: {
          order_id: input.orderId,
          customer_email: input.customerEmail,
          total_sar: grand,
          vat_sar: vat,
          subtotal_ex_vat_sar: base,
          issued_at: issued,
        },
      });
    } catch {
      // Non-fatal — the email went out regardless.
    }
  }
}
