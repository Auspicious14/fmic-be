import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { timingSafeEqual } from 'crypto';
import {
  Customer,
  CustomerDocument,
} from '../customers/schemas/customer.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionType } from '../transactions/schemas/transaction.schema';
import { ReceiptService } from '../transactions/receipt.service';
import { ReceiptImageService } from '../transactions/receipt-image.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { publicApiUrl, verifyLink } from '../../common/utils/signed-link';

const FLW_BASE_URL = 'https://api.flutterwave.com/v3';
const naira = (amount: number) =>
  `₦${Math.round(Number(amount) || 0).toLocaleString('en-NG')}`;
const TX_REF_PREFIX = 'ledga';

/**
 * Flutterwave Standard checkout for a customer's outstanding balance.
 *
 * 1. Receipt "Pay now" -> GET /api/pay/:customerId?s=<signature>
 * 2. We create a checkout for the CURRENT balance and redirect to Flutterwave.
 * 3. Flutterwave calls our webhook, and sends the customer back to
 *    /api/pay/done. Either one re-verifies the transaction with Flutterwave
 *    and records the payment once, which lowers the balance.
 * 4. The shop owner gets a WhatsApp message saying who paid.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly transactionsService: TransactionsService,
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly whatsappApi: WhatsappApiService,
    private readonly receiptService: ReceiptService,
    private readonly receiptImageService: ReceiptImageService,
  ) {}

  private get secretKey(): string | undefined {
    return this.configService.get<string>('FLW_SECRET_KEY');
  }

  /** Returns the Flutterwave checkout URL, or null when nothing is owed. */
  async createCheckoutForCustomer(
    customerId: string,
    signature?: string,
  ): Promise<{ link: string | null; shopName: string }> {
    if (!verifyLink('pay', customerId, signature)) {
      throw new UnauthorizedException('This payment link is not valid');
    }
    if (!this.secretKey) throw new Error('FLW_SECRET_KEY is not set');
    if (!Types.ObjectId.isValid(customerId)) {
      throw new NotFoundException('Customer not found');
    }

    const customer = await this.customerModel.findById(customerId).exec();
    if (!customer || customer.isDeleted) {
      throw new NotFoundException('Customer not found');
    }
    const owner = await this.userModel
      .findById(customer.shopOwner)
      .select('shopName name email')
      .exec();
    const shopName = owner?.shopName || owner?.name || 'the shop';

    const amount = Math.round(Number(customer.outstandingBalance) || 0);
    if (amount <= 0) return { link: null, shopName };

    const txRef = `${TX_REF_PREFIX}-${customerId}-${Date.now()}`;
    const response = await fetch(`${FLW_BASE_URL}/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tx_ref: txRef,
        amount,
        currency: 'NGN',
        redirect_url: `${publicApiUrl()}/api/pay/done`,
        customer: {
          // Flutterwave requires an email; many market customers have none.
          email:
            customer.email ||
            this.configService.get<string>('FLW_FALLBACK_EMAIL') ||
            owner?.email,
          phonenumber: customer.phone || undefined,
          name: customer.name,
        },
        meta: {
          customerId,
          shopOwner: customer.shopOwner?.toString(),
        },
        customizations: {
          title: shopName,
          description: `Payment of what you owe ${shopName} (via Ledga)`,
        },
      }),
      signal: AbortSignal.timeout(20000),
    });

    const json: any = await response.json().catch(() => ({}));
    if (!response.ok || json?.status !== 'success' || !json?.data?.link) {
      throw new Error(
        `Flutterwave checkout failed (${response.status}): ${json?.message ?? 'no link'}`,
      );
    }
    this.logger.log(`[Pay] checkout ${txRef} for ₦${amount}`);
    return { link: json.data.link, shopName };
  }

  /**
   * Webhook from Flutterwave. Never trust the payload alone: check the secret
   * hash header, then ask Flutterwave directly whether the payment succeeded.
   */
  async handleWebhook(
    verifHash: string | undefined,
    payload: any,
  ): Promise<{ recorded: boolean; reason?: string }> {
    const expected = this.configService.get<string>('FLW_SECRET_HASH');
    if (!expected || !verifHash || !this.safeEqual(expected, verifHash)) {
      // Answer 200 anyway: Flutterwave's dashboard test and retries treat a
      // 401 as "webhook broken". Nothing is recorded without the hash.
      this.logger.warn('[Pay] webhook with a missing or wrong verif-hash ignored');
      return { recorded: false, reason: 'invalid signature' };
    }

    const event = payload?.event ?? payload?.['event.type'];
    const data = payload?.data ?? {};
    if (event !== 'charge.completed' || data.status !== 'successful') {
      return { recorded: false, reason: `ignored ${event}/${data.status}` };
    }
    if (!data.id) return { recorded: false, reason: 'missing transaction id' };
    return this.recordVerifiedPayment(data.id);
  }

  /**
   * The customer came back from checkout (/api/pay/done?transaction_id=…).
   * Records the payment here too, so it doesn't depend on the webhook alone.
   */
  async recordFromRedirect(
    transactionId?: string,
  ): Promise<{ recorded: boolean; reason?: string }> {
    if (!transactionId || !/^\d+$/.test(transactionId)) {
      return { recorded: false, reason: 'missing transaction id' };
    }
    try {
      return await this.recordVerifiedPayment(transactionId);
    } catch (error) {
      this.logger.warn(`[Pay] redirect check failed: ${(error as Error).message}`);
      return { recorded: false, reason: 'verification error' };
    }
  }

  /** Asks Flutterwave about the payment and records it once. */
  private async recordVerifiedPayment(
    id: string | number,
  ): Promise<{ recorded: boolean; reason?: string }> {
    const verified = await this.verifyTransaction(id);
    if (
      verified.status !== 'successful' ||
      verified.currency !== 'NGN' ||
      !String(verified.tx_ref ?? '').startsWith(`${TX_REF_PREFIX}-`)
    ) {
      return { recorded: false, reason: 'verification failed' };
    }

    const customerId = String(verified.tx_ref).split('-')[1];
    const customer = Types.ObjectId.isValid(customerId)
      ? await this.customerModel.findById(customerId).exec()
      : null;
    if (!customer) return { recorded: false, reason: 'unknown customer' };

    const idempotencyKey = `flw-${verified.id}`;
    // Webhook and redirect both arrive for one payment: record and notify once.
    if (await this.transactionsService.existsByIdempotencyKey(idempotencyKey)) {
      return { recorded: true, reason: 'already recorded' };
    }
    const saved = await this.transactionsService.create(
      {
        customerId,
        type: TransactionType.PAYMENT,
        amount: Number(verified.amount),
        items: [],
        voiceTranscript: `Paid online via Flutterwave (ref ${verified.flw_ref ?? verified.tx_ref})`,
        // Flutterwave may send the same webhook more than once.
        idempotencyKey,
      },
      customer.shopOwner.toString(),
    );
    this.logger.log(
      `[Pay] recorded ₦${verified.amount} from customer ${customerId} (flw ${verified.id})`,
    );
    await this.notifyShop(saved, customerId, Number(verified.amount)).catch((error) =>
      this.logger.warn(`[Pay] WhatsApp notice failed: ${(error as Error).message}`),
    );
    return { recorded: true };
  }

  /**
   * Tells the trader on WhatsApp who paid, with a receipt to forward.
   * WhatsApp only allows free-form messages within 24 hours of the trader's
   * last message; after that, an approved template is needed
   * (WHATSAPP_PAYMENT_TEMPLATE, body: "{{1}} paid you {{2}} online. They now owe {{3}}.").
   */
  private async notifyShop(saved: any, customerId: string, amount: number): Promise<void> {
    const customer = await this.customerModel.findById(customerId).exec();
    if (!customer) return;
    const owner = await this.userModel
      .findById(customer.shopOwner)
      .select('name shopName whatsappPhone')
      .exec();
    const phone = owner?.whatsappPhone;
    if (!phone || !this.whatsappApi.isEnabled()) return;

    const balance = Number(customer.outstandingBalance) || 0;
    const text = `💰 ${customer.name} just paid you ${naira(amount)} online.\n${
      balance > 0 ? `${customer.name} still owes ${naira(balance)}.` : `${customer.name} doesn't owe you anything now.`
    }`;
    try {
      await this.whatsappApi.sendText(phone, text);
    } catch (error) {
      const template = this.configService.get<string>('WHATSAPP_PAYMENT_TEMPLATE');
      if (!template) throw error;
      await this.whatsappApi.sendTemplate(phone, template, [
        customer.name,
        naira(amount),
        naira(balance),
      ]);
      return; // a receipt image can't follow a template outside the 24h window
    }

    const receipt = this.receiptService.buildReceiptData(saved, customer, owner);
    const png = await this.receiptImageService.render(receipt);
    if (png) {
      await this.whatsappApi.sendImage(
        phone,
        png,
        `Receipt from ${receipt.businessName}: payment of ${naira(amount)} received. Thank you!`,
      );
    }
  }

  private async verifyTransaction(id: string | number): Promise<any> {
    const response = await fetch(
      `${FLW_BASE_URL}/transactions/${encodeURIComponent(String(id))}/verify`,
      {
        headers: { Authorization: `Bearer ${this.secretKey}` },
        signal: AbortSignal.timeout(20000),
      },
    );
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok || json?.status !== 'success') {
      throw new Error(`Flutterwave verify failed (${response.status})`);
    }
    return json.data ?? {};
  }

  private safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }
}
