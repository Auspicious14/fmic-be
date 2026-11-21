import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  buildPayUrl,
  buildPublicReceiptUrl,
} from '../../common/utils/signed-link';
import { formatPayout, PayoutDetails } from '../../common/utils/banks';
import {
  LAGOS_TIME_ZONE,
  lagosDateCompact,
  lagosDateString,
} from '../../common/utils/lagos-time';

/** Trader-typed text going into receipt HTML. */
const escapeHtml = (text: string) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface ReceiptData {
  transactionId: string;
  receiptNumber: string;
  businessName: string;
  businessPhone: string;
  businessAddress: string;
  customerName: string;
  customerPhone: string;
  items: Array<{
    productName: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  subtotal: number;
  tax: number;
  taxRate: number;
  totalAmount: number;
  transactionType: string;
  paymentMethod: string;
  date: string;
  time: string;
  /** YYYY-MM-DD of the transaction in Lagos time */
  issuedOn: string;
  notes?: string;
  /** What the customer owes in total right now (all receipts). */
  outstandingBalance?: number;
  /** The shop's own account to pay into by transfer, when set. */
  payTo?: PayoutDetails | null;
  /**
   * Flutterwave "Pay now" link. Only used when the shop has no account set:
   * money paid this way lands in Ledga's Flutterwave balance, not the shop's.
   */
  payUrl?: string | null;
  /** Link the customer can open without logging in. */
  receiptUrl?: string | null;
}

@Injectable()
export class ReceiptService {
  private readonly logger = new Logger(ReceiptService.name);

  /**
   * The date in the receipt number is the TRANSACTION date (Lagos time), so
   * the same receipt always has the same number no matter when it is viewed.
   * Falls back to the date embedded in the MongoDB ObjectId.
   */
  generateReceiptNumber(transactionId: string, transactionDate?: Date): string {
    const hash = crypto
      .createHash('md5')
      .update(transactionId)
      .digest('hex')
      .substring(0, 8)
      .toUpperCase();
    const date =
      transactionDate && !isNaN(transactionDate.getTime())
        ? transactionDate
        : this.dateFromObjectId(transactionId);
    return `RCP-${lagosDateCompact(date)}-${hash}`;
  }

  private dateFromObjectId(id: string): Date {
    if (/^[a-f0-9]{24}$/i.test(id)) {
      return new Date(parseInt(id.substring(0, 8), 16) * 1000);
    }
    return new Date();
  }

  buildReceiptData(
    transaction: any,
    customer: any,
    shopOwner: any,
  ): ReceiptData {
    const transactionDate = new Date(transaction.createdAt);
    const TAX_RATE = 0; // Nigerian shop — typically no VAT on informal transactions

    const items = (transaction.items || []).map((item: any) => ({
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: item.unitPriceAtSale,
      totalPrice: item.totalPrice || item.quantity * item.unitPriceAtSale,
    }));

    const payTo: PayoutDetails | null =
      shopOwner?.payoutBank && shopOwner?.payoutAccountNumber
        ? {
            bank: shopOwner.payoutBank,
            accountNumber: shopOwner.payoutAccountNumber,
            accountName: shopOwner.payoutAccountName || '',
          }
        : null;

    const subtotal = transaction.totalAmount;
    const tax = Math.round(subtotal * TAX_RATE * 100) / 100;
    const totalAmount = subtotal + tax;

    return {
      transactionId: transaction._id.toString(),
      receiptNumber: this.generateReceiptNumber(
        transaction._id.toString(),
        transactionDate,
      ),
      businessName: shopOwner?.shopName || shopOwner?.name || 'My Shop',
      businessPhone: shopOwner?.phone || '',
      businessAddress: shopOwner?.address || '',
      customerName: customer?.name || 'Walk-in Customer',
      customerPhone: customer?.phone || '',
      items,
      subtotal,
      tax,
      taxRate: TAX_RATE * 100,
      totalAmount,
      transactionType: transaction.type,
      paymentMethod:
        transaction.type === 'credit' ? 'Credit (Owe)' : 'Cash / Transfer',
      date: transactionDate.toLocaleDateString('en-NG', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: LAGOS_TIME_ZONE,
      }),
      time: transactionDate.toLocaleTimeString('en-NG', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: LAGOS_TIME_ZONE,
      }),
      issuedOn: lagosDateString(transactionDate),
      notes: transaction.voiceTranscript,
      outstandingBalance: customer?.outstandingBalance,
      receiptUrl: buildPublicReceiptUrl(transaction._id.toString()),
      payTo,
      payUrl:
        !payTo && customer?.outstandingBalance > 0
          ? buildPayUrl(customer?._id?.toString?.() ?? '')
          : null,
    };
  }

  generateReceiptHtml(data: ReceiptData): string {
    const formatCurrency = (amount: number) =>
      `₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const itemRows =
      data.items.length > 0
        ? data.items
            .map(
              (item) => `
        <tr>
          <td style="padding: 10px 8px; border-bottom: 1px solid #f1f5f9; font-size: 14px; color: #334155;">${item.productName}</td>
          <td style="padding: 10px 8px; border-bottom: 1px solid #f1f5f9; font-size: 14px; color: #64748b; text-align: center;">${item.quantity}</td>
          <td style="padding: 10px 8px; border-bottom: 1px solid #f1f5f9; font-size: 14px; color: #64748b; text-align: right;">${formatCurrency(item.unitPrice)}</td>
          <td style="padding: 10px 8px; border-bottom: 1px solid #f1f5f9; font-size: 14px; font-weight: 700; color: #0f172a; text-align: right;">${formatCurrency(item.totalPrice)}</td>
        </tr>`,
            )
            .join('')
        : `<tr><td colspan="4" style="padding: 20px 8px; text-align: center; color: #94a3b8; font-size: 13px;">Direct ${data.paymentMethod}</td></tr>`;

    const typeColor = data.transactionType === 'credit' ? '#ef4444' : '#22c55e';
    const typeBg = data.transactionType === 'credit' ? '#fef2f2' : '#f0fdf4';
    const typeLabel =
      data.transactionType === 'credit' ? 'CREDIT (OWED)' : 'PAYMENT RECEIVED';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Receipt ${data.receiptNumber}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, sans-serif; background: #f8fafc; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; padding: 24px 16px; }
  .receipt-wrapper { width: 100%; max-width: 420px; }
  .receipt { background: #ffffff; border-radius: 24px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.12); }
  .header { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 32px 28px; text-align: center; }
  .logo-ring { width: 56px; height: 56px; border-radius: 16px; background: rgba(255,255,255,0.15); display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; font-size: 24px; backdrop-filter: blur(10px); }
  .business-name { color: #ffffff; font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
  .business-sub { color: rgba(255,255,255,0.6); font-size: 12px; font-weight: 500; margin-top: 4px; letter-spacing: 0.5px; }
  .receipt-badge { margin-top: 20px; display: inline-block; background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.2); border-radius: 100px; padding: 6px 16px; color: rgba(255,255,255,0.9); font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; }
  .type-banner { padding: 12px 28px; text-align: center; background: ${typeBg}; border-bottom: 1px solid ${typeColor}22; }
  .type-label { color: ${typeColor}; font-size: 11px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; }
  .info-section { padding: 24px 28px; border-bottom: 1px solid #f1f5f9; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .info-item label { display: block; font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  .info-item span { font-size: 14px; font-weight: 600; color: #0f172a; }
  .customer-section { padding: 20px 28px; background: #f8fafc; border-bottom: 1px solid #f1f5f9; }
  .section-label { font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  .customer-name { font-size: 17px; font-weight: 800; color: #0f172a; }
  .customer-phone { font-size: 13px; color: #64748b; margin-top: 2px; font-weight: 500; }
  .items-section { padding: 20px 28px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; padding: 0 8px 12px; border-bottom: 2px solid #f1f5f9; }
  .totals-section { padding: 20px 28px; background: #f8fafc; border-top: 2px solid #f1f5f9; }
  .total-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .total-row.final { background: #0f172a; border-radius: 16px; padding: 16px 20px; margin-top: 16px; margin-bottom: 0; }
  .total-label { font-size: 13px; color: #64748b; font-weight: 500; }
  .total-label.final { color: rgba(255,255,255,0.7); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
  .total-value { font-size: 14px; color: #0f172a; font-weight: 700; }
  .total-value.final { color: #ffffff; font-size: 22px; font-weight: 900; }
  .pay-section { padding: 0 28px 20px; }
  .pay-account { text-align: center; font-size: 20px; font-weight: 800; color: #0f172a; margin: 6px 0; letter-spacing: 0.5px; }
  .pay-button { display: block; text-align: center; background: #16a34a; color: #ffffff; text-decoration: none; font-weight: 800; font-size: 15px; padding: 14px 16px; border-radius: 14px; }
  .pay-hint { text-align: center; font-size: 11px; color: #64748b; margin-top: 8px; }
  .notes-section { padding: 16px 28px; border-top: 1px dashed #e2e8f0; }
  .notes-text { font-size: 12px; color: #94a3b8; font-style: italic; line-height: 1.5; }
  .footer { padding: 24px 28px; text-align: center; border-top: 2px dashed #e2e8f0; }
  .footer-text { font-size: 11px; color: #94a3b8; line-height: 1.8; }
  .footer-brand { font-size: 10px; font-weight: 700; color: #cbd5e1; letter-spacing: 1px; text-transform: uppercase; margin-top: 12px; }
  .wave-divider { padding: 0 28px; line-height: 0; font-size: 0; }
  .wave-divider::after { content: ''; display: block; height: 1px; background: linear-gradient(90deg, transparent, #e2e8f0, transparent); }
</style>
</head>
<body>
  <div class="receipt-wrapper">
    <div class="receipt">
      <!-- Header -->
      <div class="header">
        <div class="logo-ring">🏪</div>
        <div class="business-name">${data.businessName}</div>
        <div class="business-sub">${data.businessPhone || 'Your Trusted Shop'}</div>
        <div class="receipt-badge">Official Receipt</div>
      </div>

      <!-- Transaction Type Banner -->
      <div class="type-banner">
        <div class="type-label">${typeLabel}</div>
      </div>

      <!-- Receipt Info -->
      <div class="info-section">
        <div class="info-grid">
          <div class="info-item">
            <label>Receipt No.</label>
            <span>${data.receiptNumber}</span>
          </div>
          <div class="info-item">
            <label>Date</label>
            <span>${data.date}</span>
          </div>
          <div class="info-item">
            <label>Time</label>
            <span>${data.time}</span>
          </div>
          <div class="info-item">
            <label>Reference</label>
            <span>${data.transactionId.substring(0, 8).toUpperCase()}</span>
          </div>
        </div>
      </div>

      <!-- Customer -->
      <div class="customer-section">
        <div class="section-label">Customer</div>
        <div class="customer-name">${data.customerName}</div>
        ${data.customerPhone ? `<div class="customer-phone">📱 ${data.customerPhone}</div>` : ''}
      </div>

      <!-- Items -->
      <div class="items-section">
        <div class="section-label">Items / Services</div>
        <table>
          <thead>
            <tr>
              <th style="text-align: left;">Description</th>
              <th style="text-align: center;">Qty</th>
              <th style="text-align: right;">Unit Price</th>
              <th style="text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>
      </div>

      <!-- Totals -->
      <div class="totals-section">
        <div class="total-row">
          <span class="total-label">Subtotal</span>
          <span class="total-value">${formatCurrency(data.subtotal)}</span>
        </div>
        ${
          data.tax > 0
            ? `
        <div class="total-row">
          <span class="total-label">Tax (${data.taxRate}%)</span>
          <span class="total-value">${formatCurrency(data.tax)}</span>
        </div>`
            : ''
        }
        <div class="total-row final">
          <span class="total-label final">Total Amount</span>
          <span class="total-value final">${formatCurrency(data.totalAmount)}</span>
        </div>
      </div>

      ${
        data.payTo && (data.outstandingBalance ?? 0) > 0
          ? `
      <!-- Pay by transfer to the shop's own account -->
      <div class="pay-section">
        <div class="pay-hint">Pay ${formatCurrency(data.outstandingBalance ?? 0)} by transfer to</div>
        <div class="pay-account">${escapeHtml(data.payTo.bank)} · ${escapeHtml(data.payTo.accountNumber)}</div>
        <div class="pay-hint">${escapeHtml(data.payTo.accountName)}</div>
      </div>`
          : ''
      }

      ${
        data.payUrl
          ? `
      <!-- Pay now (Flutterwave) -->
      <div class="pay-section">
        <a class="pay-button" href="${data.payUrl}">Pay ${formatCurrency(data.outstandingBalance ?? 0)} now</a>
        <div class="pay-hint">Secure payment by card, transfer or USSD via Flutterwave</div>
      </div>`
          : ''
      }

      ${
        data.notes
          ? `
      <!-- Notes -->
      <div class="notes-section">
        <div class="notes-text">📋 ${data.notes}</div>
      </div>`
          : ''
      }

      <!-- Footer -->
      <div class="footer">
        <div class="footer-text">
          Thank you for your business!<br>
          ${data.businessAddress ? data.businessAddress + '<br>' : ''}
          This is an official transaction receipt.<br>
          <strong>Powered by Ledga</strong>
        </div>
        <div class="footer-brand">Issued ${data.issuedOn}</div>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  generateWhatsAppMessage(data: ReceiptData): string {
    const formatCurrency = (amount: number) =>
      `₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;

    const typeEmoji = data.transactionType === 'credit' ? '📋' : '✅';
    const typeLabel =
      data.transactionType === 'credit' ? 'CREDIT (OWED)' : 'PAYMENT RECEIVED';

    const itemsList =
      data.items.length > 0
        ? data.items
            .map(
              (item) =>
                `  • ${item.productName} x${item.quantity} @ ${formatCurrency(item.unitPrice)} = *${formatCurrency(item.totalPrice)}*`,
            )
            .join('\n')
        : `  • ${data.paymentMethod}`;

    return `${typeEmoji} *TRANSACTION RECEIPT*
━━━━━━━━━━━━━━━━━━━━━━
🏪 *${data.businessName}*
${data.businessPhone ? `📞 ${data.businessPhone}` : ''}

📄 Receipt No: *${data.receiptNumber}*
📅 Date: ${data.date}
⏰ Time: ${data.time}
━━━━━━━━━━━━━━━━━━━━━━
👤 *Customer:* ${data.customerName}
🏷️ *Type:* ${typeLabel}
━━━━━━━━━━━━━━━━━━━━━━
📦 *ITEMS:*
${itemsList}
━━━━━━━━━━━━━━━━━━━━━━
💰 *TOTAL: ${formatCurrency(data.totalAmount)}*
${data.notes ? `\n📝 _${data.notes}_` : ''}

${data.receiptUrl ? `\n🧾 View receipt: ${data.receiptUrl}` : ''}${data.payTo && (data.outstandingBalance ?? 0) > 0 ? `\n🏦 *Pay by transfer:* ${formatPayout(data.payTo)}\n` : ''}${data.payUrl ? `\n💳 *Pay ${formatCurrency(data.outstandingBalance ?? 0)} now:* ${data.payUrl}\n` : ''}
_Thank you for your business!_
_Powered by Ledga_`;
  }

  buildWhatsAppUrl(phone: string, message: string): string {
    // Normalize phone number — remove leading 0, add country code if Nigerian
    let normalized = phone.replace(/\s/g, '').replace(/[^0-9+]/g, '');
    if (normalized.startsWith('0')) {
      normalized = '+234' + normalized.substring(1);
    }
    if (!normalized.startsWith('+')) {
      normalized = '+' + normalized;
    }
    const encoded = encodeURIComponent(message);
    return `https://wa.me/${normalized.replace('+', '')}?text=${encoded}`;
  }
}
