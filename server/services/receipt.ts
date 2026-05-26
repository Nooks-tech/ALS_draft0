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
  // 'drivethru' = "Receive from your car" — shows up on the receipt
  // as "Car pickup" with the customer's car identifiers below.
  orderType: 'delivery' | 'pickup' | 'drivethru' | 'dine_in';
  branchName?: string | null;
  paymentMethod?: string | null;
  paymentId?: string | null;
  /** Only included on drivethru orders. */
  carDetails?: {
    plate_letters?: string | null;
    plate_numbers?: string | null;
    model?: string | null;
    color?: string | null;
  } | null;
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
                <td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);color:#f2e8d0;font-size:14px;">${escapeHtml(i.name)} <span style="color:rgba(242,232,208,0.5);font-size:13px;">×${i.quantity}</span></td>
                <td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);text-align:right;color:#f2e8d0;font-size:14px;font-weight:600;">${fmtSar(i.price_sar * i.quantity)}</td>
              </tr>`,
    )
    .join('');

  const deliveryRow = input.deliveryFeeSar && input.deliveryFeeSar > 0
    ? `
              <tr>
                <td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);color:rgba(242,232,208,0.7);font-size:14px;">Delivery</td>
                <td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);text-align:right;color:rgba(242,232,208,0.7);font-size:14px;">${fmtSar(input.deliveryFeeSar)}</td>
              </tr>`
    : '';

  const branchLabel = escapeHtml(input.branchName ?? 'Nooks');
  const orderIdEscaped = escapeHtml(input.orderId);
  const orderTypeLabel =
    input.orderType === 'delivery'
      ? 'Delivery'
      : input.orderType === 'drivethru'
        ? 'Car pickup'
        : 'Pickup';
  // Curbside receipt row — vehicle identifiers so the customer
  // remembers what they entered and the merchant can cross-check
  // when the car arrives. Built defensively from possibly-null
  // sub-fields (DB JSONB can have any subset).
  const carDetailsRow =
    input.orderType === 'drivethru' && input.carDetails
      ? (() => {
          const cd = input.carDetails!;
          const plate = [cd.plate_letters, cd.plate_numbers]
            .filter((p) => p && String(p).trim())
            .map((p) => escapeHtml(String(p).trim()))
            .join(' ');
          const parts: string[] = [];
          if (plate) parts.push(plate);
          if (cd.model && String(cd.model).trim()) parts.push(escapeHtml(String(cd.model).trim()));
          if (cd.color && String(cd.color).trim()) parts.push(escapeHtml(String(cd.color).trim()));
          if (parts.length === 0) return '';
          return `
              <tr>
                <td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);color:rgba(242,232,208,0.7);font-size:14px;">Car</td>
                <td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);text-align:right;color:#f2e8d0;font-size:14px;font-weight:600;">${parts.join(' &middot; ')}</td>
              </tr>`;
        })()
      : '';
  const paymentMethodEscaped = escapeHtml(input.paymentMethod ?? 'Card');
  const paymentRefEscaped = input.paymentId ? ` · ref ${escapeHtml(input.paymentId)}` : '';

  const html = `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Your Nooks receipt</title>
</head>
<body style="margin:0;padding:0;background:#0b0a08;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f2e8d0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0a08;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#15110a;border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
              <img src="https://nooks.space/nooks-mark.png" width="44" height="44" alt="Nooks" style="display:block;border-radius:10px;margin-bottom:14px;" />
              <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#c9a961;font-weight:600;">Nooks · Order receipt</div>
              <h1 style="margin:8px 0 4px;font-size:24px;line-height:1.25;color:#f2e8d0;font-weight:700;">
                Thanks for ordering
              </h1>
              <p style="margin:0 0 24px;font-size:14px;line-height:1.55;color:rgba(242,232,208,0.7);">
                ${branchLabel} &middot; ${new Date(issued).toLocaleString('en-GB')}<br/>
                Order <code style="background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:6px;color:#c9a961;font-size:12px;">${orderIdEscaped}</code> &middot; ${orderTypeLabel}
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 32px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${rows}
                ${deliveryRow}
                ${carDetailsRow}
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:8px 32px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:4px 0;color:rgba(242,232,208,0.55);font-size:13px;">Subtotal (excl. VAT)</td>
                  <td style="padding:4px 0;text-align:right;color:rgba(242,232,208,0.7);font-size:13px;">${fmtSar(base)}</td>
                </tr>
                <tr>
                  <td style="padding:4px 0;color:rgba(242,232,208,0.55);font-size:13px;">VAT (15%)</td>
                  <td style="padding:4px 0;text-align:right;color:rgba(242,232,208,0.7);font-size:13px;">${fmtSar(vat)}</td>
                </tr>
                <tr>
                  <td style="padding:12px 0 0;border-top:1px solid rgba(255,255,255,0.1);color:#f2e8d0;font-size:15px;font-weight:700;">Total</td>
                  <td style="padding:12px 0 0;border-top:1px solid rgba(255,255,255,0.1);text-align:right;color:#c9a961;font-size:18px;font-weight:700;">${fmtSar(grand)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 32px 28px;border-top:1px solid rgba(255,255,255,0.06);">
              <p style="margin:0 0 6px;font-size:12px;line-height:1.55;color:rgba(242,232,208,0.5);">
                Payment: ${paymentMethodEscaped}${paymentRefEscaped}
              </p>
              <p style="margin:0;font-size:12px;line-height:1.55;color:rgba(242,232,208,0.4);">
                Thank you for ordering with ${branchLabel}.
              </p>
            </td>
          </tr>
        </table>

        <p style="max-width:560px;margin:16px auto 0;font-size:11px;color:rgba(242,232,208,0.3);text-align:center;">
          Sent by Nooks &middot; <a href="https://nooks.space" style="color:rgba(242,232,208,0.5);text-decoration:none;">nooks.space</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

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
