import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { PaymentsService } from './payments.service';
import { TransactionsService } from '../transactions/transactions.service';
import { verifyLink } from '../../common/utils/signed-link';

/**
 * Public routes opened by customers from a receipt (no login), plus the
 * Flutterwave webhook. Every customer-facing link carries an HMAC signature.
 */
@ApiExcludeController()
@Controller()
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly transactionsService: TransactionsService,
  ) {}

  /** Flutterwave sends the customer back here after checkout. */
  @Get('pay/done')
  async payDone(
    @Query('status') status: string,
    @Query('transaction_id') transactionId: string,
    @Res() res: Response,
  ) {
    const ok = status === 'successful' || status === 'completed';
    // The query string is only a hint: the payment is checked with
    // Flutterwave before anything is recorded.
    if (ok) await this.paymentsService.recordFromRedirect(transactionId);
    return this.sendPage(
      res,
      ok ? 'Payment received' : 'Payment not completed',
      ok
        ? 'Thank you! Your payment has gone through. The shop will see it on their Ledga straight away.'
        : 'Your payment did not go through and you have not been charged. You can open the link again to retry.',
    );
  }

  /** "Pay now" from a receipt: checkout for what the customer owes today. */
  @Get('pay/:customerId')
  async pay(
    @Param('customerId') customerId: string,
    @Query('s') signature: string,
    @Res() res: Response,
  ) {
    try {
      const { link, shopName } =
        await this.paymentsService.createCheckoutForCustomer(customerId, signature);
      if (!link) {
        return this.sendPage(
          res,
          'Nothing to pay',
          `You don't owe ${shopName} anything right now. Thank you!`,
        );
      }
      return res.redirect(302, link);
    } catch (error) {
      this.logger.warn(`[Pay] ${(error as Error).message}`);
      return this.sendPage(
        res,
        'Payment link problem',
        'We could not open this payment link. Please ask the shop to send you a new receipt.',
        400,
      );
    }
  }

  /** Public receipt a customer opens from WhatsApp. */
  @Get('r/:id')
  async publicReceipt(
    @Param('id') id: string,
    @Query('s') signature: string,
    @Res() res: Response,
  ) {
    if (!verifyLink('receipt', id, signature)) {
      return this.sendPage(res, 'Receipt not found', 'This receipt link is not valid.', 404);
    }
    try {
      const html = await this.transactionsService.getPublicReceiptHtml(id);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    } catch {
      return this.sendPage(res, 'Receipt not found', 'This receipt could not be found.', 404);
    }
  }

  @Post('payments/flutterwave/webhook')
  @HttpCode(200)
  async flutterwaveWebhook(
    @Headers('verif-hash') verifHash: string,
    @Body() payload: any,
  ) {
    return this.paymentsService.handleWebhook(verifHash, payload);
  }

  private sendPage(res: Response, title: string, message: string, status = 200) {
    const escape = (text: string) =>
      text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Ledga</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f5f0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#14231c}
.card{background:#fff;max-width:420px;margin:24px;padding:32px 28px;border-radius:20px;box-shadow:0 10px 30px rgba(20,35,28,.08);text-align:center}
h1{font-size:22px;margin:0 0 12px}p{font-size:15px;line-height:1.6;color:#4b5a52;margin:0}.brand{margin-top:24px;font-size:12px;font-weight:700;color:#0e7a4f;letter-spacing:.5px}</style>
</head><body><div class="card"><h1>${escape(title)}</h1><p>${escape(message)}</p><div class="brand">Ledga</div></div></body></html>`);
  }
}
