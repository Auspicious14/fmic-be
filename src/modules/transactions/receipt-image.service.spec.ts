import { ReceiptImageService } from './receipt-image.service';
import type { ReceiptData } from './receipt.service';

describe('ReceiptImageService', () => {
  const base: ReceiptData = {
    transactionId: 't1',
    receiptNumber: 'RCP-20261121-1A2B3C4D',
    businessName: 'Mama Shop',
    businessPhone: '',
    businessAddress: '',
    customerName: 'Alfa',
    customerPhone: '',
    items: [
      { productName: 'Rice', quantity: 2, unitPrice: 700, totalPrice: 1400 },
    ],
    subtotal: 1400,
    tax: 0,
    taxRate: 0,
    totalAmount: 1400,
    transactionType: 'credit',
    paymentMethod: 'Credit (Owe)',
    date: 'Saturday, 21 November 2026',
    time: '01:41 pm',
    issuedOn: '2026-11-21',
    outstandingBalance: 1400,
    payUrl: 'https://api.example.com/api/pay/c1?s=x',
  };

  it('draws a credit receipt as a PNG', async () => {
    const png = await new ReceiptImageService().render(base);
    expect(png).not.toBeNull();
    expect(png!.subarray(1, 4).toString()).toBe('PNG');
    if (process.env.RECEIPT_PNG_OUT)
      require('fs').writeFileSync(
        `${process.env.RECEIPT_PNG_OUT}/credit.png`,
        png,
      );
  });

  it('draws a payment receipt with no items', async () => {
    const png = await new ReceiptImageService().render({
      ...base,
      items: [],
      transactionType: 'payment',
      outstandingBalance: 0,
      payUrl: null,
    });
    expect(png).not.toBeNull();
    if (process.env.RECEIPT_PNG_OUT)
      require('fs').writeFileSync(
        `${process.env.RECEIPT_PNG_OUT}/paid.png`,
        png,
      );
  });
});
