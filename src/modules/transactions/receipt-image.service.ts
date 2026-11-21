import { Injectable, Logger } from '@nestjs/common';
import type { ReceiptData } from './receipt.service';
import {
  INTER_EXT_400,
  INTER_EXT_700,
  INTER_LATIN_400,
  INTER_LATIN_700,
  INTER_MARKS_400,
  INTER_MARKS_700,
} from './receipt-fonts';

type Node = {
  type: string;
  props: { style?: Record<string, unknown>; children?: unknown };
};

/** Tiny element builder for satori (it takes React-like objects, no JSX needed). */
const h = (
  style: Record<string, unknown>,
  children?: unknown,
  type = 'div',
): Node => ({
  type,
  props: { style: { display: 'flex', ...style }, children },
});

const naira = (amount: number) =>
  `₦${Math.round(Number(amount) || 0).toLocaleString('en-NG')}`;

const COLORS = {
  ink: '#14231c',
  muted: '#5b6b62',
  line: '#e4e1d6',
  paper: '#fffdf7',
  brand: '#0e7a4f',
  owe: '#b4231a',
};

/**
 * Draws a receipt as a PNG, so the bot can send a picture the trader forwards
 * to the customer, instead of a link they have to open.
 */
@Injectable()
export class ReceiptImageService {
  private readonly logger = new Logger(ReceiptImageService.name);
  private fonts: Array<{
    name: string;
    data: Buffer;
    weight: 400 | 700;
  }> | null = null;

  private loadFonts() {
    if (this.fonts) return this.fonts;
    // Satori falls back through the families in order: letters, then ₦ and
    // Yoruba/Hausa/Igbo letters (ṣ, ń), then dot-below vowels (ẹ, ọ).
    const font = (name: string, weight: 400 | 700, base64: string) => ({
      name,
      weight,
      data: Buffer.from(base64, 'base64'),
    });
    this.fonts = [
      font('Inter', 400, INTER_LATIN_400),
      font('Inter', 700, INTER_LATIN_700),
      font('InterExt', 400, INTER_EXT_400),
      font('InterExt', 700, INTER_EXT_700),
      font('InterMarks', 400, INTER_MARKS_400),
      font('InterMarks', 700, INTER_MARKS_700),
    ];
    return this.fonts;
  }

  /** PNG bytes, or null if drawing fails (the caller then sends a link). */
  async render(data: ReceiptData): Promise<Buffer | null> {
    try {
      // Loaded lazily: a broken native module must not stop the app booting.
      /* eslint-disable @typescript-eslint/no-require-imports */
      const satori = (
        require('satori') as { default: (...args: any[]) => Promise<string> }
      ).default;
      const { Resvg } =
        require('@resvg/resvg-js') as typeof import('@resvg/resvg-js');
      /* eslint-enable @typescript-eslint/no-require-imports */

      const width = 720;
      const svg = await satori(this.layout(data), {
        width,
        fonts: this.loadFonts(),
      });
      return new Resvg(svg, { fitTo: { mode: 'width', value: width } })
        .render()
        .asPng();
    } catch (error) {
      this.logger.warn(
        `[ReceiptImage] could not draw receipt: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private layout(d: ReceiptData): Node {
    const isPayment = d.transactionType === 'payment';
    const balance = Number(d.outstandingBalance ?? 0);

    const itemRows = d.items.length
      ? d.items.map((item) =>
          h(
            {
              justifyContent: 'space-between',
              padding: '14px 0',
              borderBottom: `1px solid ${COLORS.line}`,
              fontSize: 26,
            },
            [
              h({ flexDirection: 'column', maxWidth: 420 }, [
                h({ fontWeight: 700, color: COLORS.ink }, item.productName),
                h(
                  { color: COLORS.muted, fontSize: 22, marginTop: 4 },
                  `${item.quantity} × ${naira(item.unitPrice)}`,
                ),
              ]),
              h({ fontWeight: 700, color: COLORS.ink }, naira(item.totalPrice)),
            ],
          ),
        )
      : [
          h(
            {
              padding: '14px 0',
              borderBottom: `1px solid ${COLORS.line}`,
              fontSize: 26,
              color: COLORS.muted,
            },
            isPayment ? 'Payment' : 'Credit',
          ),
        ];

    return h(
      {
        flexDirection: 'column',
        background: COLORS.paper,
        fontFamily: 'Inter, InterExt, InterMarks',
        color: COLORS.ink,
        padding: 48,
      },
      [
        // Shop
        h(
          {
            flexDirection: 'column',
            alignItems: 'center',
            paddingBottom: 28,
            borderBottom: `2px dashed ${COLORS.line}`,
          },
          [
            h(
              { fontSize: 40, fontWeight: 700, textAlign: 'center' },
              d.businessName,
            ),
            h(
              { fontSize: 22, color: COLORS.muted, marginTop: 8 },
              `${d.date}, ${d.time}`,
            ),
            h(
              { fontSize: 20, color: COLORS.muted, marginTop: 4 },
              d.receiptNumber,
            ),
          ],
        ),

        // Customer + what this receipt is
        h(
          {
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '28px 0 8px',
          },
          [
            h({ flexDirection: 'column' }, [
              h(
                { fontSize: 22, color: COLORS.muted },
                isPayment ? 'Received from' : 'Sold to',
              ),
              h(
                { fontSize: 32, fontWeight: 700, marginTop: 4 },
                d.customerName,
              ),
            ]),
            h(
              {
                fontSize: 22,
                fontWeight: 700,
                padding: '8px 18px',
                borderRadius: 999,
                color: isPayment ? COLORS.brand : COLORS.owe,
                border: `2px solid ${isPayment ? COLORS.brand : COLORS.owe}`,
              },
              isPayment ? 'PAID' : 'ON CREDIT',
            ),
          ],
        ),

        h({ flexDirection: 'column', marginTop: 12 }, itemRows),

        h(
          {
            justifyContent: 'space-between',
            padding: '22px 0',
            fontSize: 30,
            fontWeight: 700,
          },
          [
            h({}, isPayment ? 'Amount paid' : 'Total'),
            h({}, naira(d.totalAmount)),
          ],
        ),

        // Balance: the number the customer cares about most.
        h(
          {
            flexDirection: 'column',
            alignItems: 'center',
            padding: '26px 24px',
            borderRadius: 24,
            background: balance > 0 ? '#fbeceb' : '#e7f4ec',
          },
          [
            h(
              { fontSize: 24, color: COLORS.muted },
              balance > 0 ? `${d.customerName} owes in total` : 'Balance',
            ),
            h(
              {
                fontSize: 56,
                fontWeight: 700,
                marginTop: 6,
                color: balance > 0 ? COLORS.owe : COLORS.brand,
              },
              balance > 0 ? naira(balance) : 'All paid',
            ),
            balance > 0 && !d.payTo && d.payUrl
              ? h(
                  {
                    fontSize: 22,
                    color: COLORS.ink,
                    marginTop: 10,
                    textAlign: 'center',
                  },
                  'Pay online with the link sent with this receipt',
                )
              : null,
          ].filter(Boolean),
        ),

        // Where to pay: the shop's own bank or wallet account.
        balance > 0 && d.payTo
          ? h(
              {
                flexDirection: 'column',
                alignItems: 'center',
                marginTop: 20,
                padding: '24px',
                borderRadius: 24,
                border: `2px solid ${COLORS.line}`,
              },
              [
                h({ fontSize: 22, color: COLORS.muted }, 'Pay by transfer to'),
                h(
                  { fontSize: 30, fontWeight: 700, marginTop: 8 },
                  d.payTo.bank,
                ),
                h(
                  {
                    fontSize: 44,
                    fontWeight: 700,
                    marginTop: 4,
                    letterSpacing: 2,
                  },
                  d.payTo.accountNumber,
                ),
                h(
                  { fontSize: 24, marginTop: 4, textAlign: 'center' },
                  d.payTo.accountName,
                ),
              ],
            )
          : null,

        h(
          {
            justifyContent: 'center',
            marginTop: 32,
            fontSize: 20,
            color: COLORS.muted,
          },
          [
            h({}, 'Recorded with '),
            h({ fontWeight: 700, color: COLORS.brand, marginLeft: 6 }, 'Ledga'),
          ],
        ),
      ].filter(Boolean),
    );
  }
}
