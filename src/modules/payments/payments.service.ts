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
import { publicApiUrl, verifyLink } from '../../common/utils/signed-link';

const FLW_BASE_URL = 'https://api.flutterwave.com/v3';
const TX_REF_PREFIX = 'ledga';

/**
 * Flutterwave Standard checkout for a customer's outstanding balance.
 *
 * 1. Receipt "Pay now" -> GET /api/pay/:customerId?s=<signature>
 * 2. We create a checkout for the CURRENT balance and redirect to Flutterwave.
 * 3. Flutterwave calls our webhook; we re-verify the transaction with
 *    Flutterwave and record a payment, which lowers the balance.
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
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const event = payload?.event ?? payload?.['event.type'];
    const data = payload?.data ?? {};
    if (event !== 'charge.completed' || data.status !== 'successful') {
      return { recorded: false, reason: `ignored ${event}/${data.status}` };
    }
    if (!data.id) return { recorded: false, reason: 'missing transaction id' };

    const verified = await this.verifyTransaction(data.id);
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

    await this.transactionsService.create(
      {
        customerId,
        type: TransactionType.PAYMENT,
        amount: Number(verified.amount),
        items: [],
        voiceTranscript: `Paid online via Flutterwave (ref ${verified.flw_ref ?? verified.tx_ref})`,
        // Flutterwave may send the same webhook more than once.
        idempotencyKey: `flw-${verified.id}`,
      },
      customer.shopOwner.toString(),
    );
    this.logger.log(
      `[Pay] recorded ₦${verified.amount} from customer ${customerId} (flw ${verified.id})`,
    );
    return { recorded: true };
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
