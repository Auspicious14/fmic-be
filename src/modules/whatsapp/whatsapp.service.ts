import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { VoiceService } from '../voice/voice.service';
import { VoiceIntent } from '../voice/dto/voice-output.dto';
import { CustomersService } from '../customers/customers.service';
import { TransactionsService } from '../transactions/transactions.service';
import { ReceiptService } from '../transactions/receipt.service';
import { TransactionType } from '../transactions/schemas/transaction.schema';
import { buildPublicReceiptUrl } from '../../common/utils/signed-link';
import { WhatsappApiService } from './whatsapp-api.service';
import {
  WhatsappPending,
  WhatsappPendingDocument,
  WhatsappSeen,
  WhatsappSeenDocument,
} from './schemas/whatsapp.schema';

const CONFIRM_ID = 'ledga_confirm';
const CANCEL_ID = 'ledga_cancel';
const YES_WORDS = ['yes', 'y', 'ok', 'okay', 'save', 'correct', 'na so', 'bẹ́ẹ̀ ni', 'beeni', '✅', '👍'];
const NO_WORDS = ['no', 'n', 'cancel', 'wrong', 'no be so', 'rara', 'rárá', '❌'];
const RECORDABLE = [VoiceIntent.CREDIT_SALE, VoiceIntent.PAYMENT];

const naira = (amount: number) =>
  `₦${Math.round(Number(amount) || 0).toLocaleString('en-NG')}`;

/**
 * The Ledga WhatsApp bot. A trader voice-notes (or types) a sale, gets a
 * summary back with ✅/❌, and on ✅ the entries are saved exactly like the
 * web app does, with a receipt link to forward to the customer.
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly api: WhatsappApiService,
    private readonly voiceService: VoiceService,
    private readonly customersService: CustomersService,
    private readonly transactionsService: TransactionsService,
    private readonly receiptService: ReceiptService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(WhatsappPending.name)
    private readonly pendingModel: Model<WhatsappPendingDocument>,
    @InjectModel(WhatsappSeen.name)
    private readonly seenModel: Model<WhatsappSeenDocument>,
  ) {}

  /** Entry point for the Meta webhook body. */
  async handleWebhook(payload: any): Promise<void> {
    const messages: any[] = [];
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        messages.push(...(change?.value?.messages ?? []));
      }
    }
    for (const message of messages) {
      try {
        await this.handleMessage(message);
      } catch (error) {
        this.logger.error(
          `[WhatsApp] failed on message ${message?.id}: ${(error as Error).message}`,
        );
        await this.api
          .sendText(
            message.from,
            'Sorry, something went wrong on our side. Abeg try again in a minute.',
          )
          .catch(() => undefined);
      }
    }
  }

  async handleMessage(message: any): Promise<void> {
    const from: string = message?.from;
    if (!from || !message?.id) return;
    if (!(await this.markSeen(message.id))) return; // duplicate delivery

    const user = await this.userModel.findOne({ whatsappPhone: from }).exec();
    if (!user) {
      const appUrl = this.configService.get<string>('APP_URL') || 'the Ledga app';
      await this.api.sendText(
        from,
        `Hi! This number isn't linked to a Ledga shop yet.\n\nOpen ${appUrl}, go to Settings → WhatsApp, and add this number. Then send me a voice note like: "Mama Tunde collect 2 rice, she go pay Friday."`,
      );
      return;
    }
    const userId = user._id.toString();

    if (message.type === 'interactive') {
      const id = message.interactive?.button_reply?.id;
      if (id === CONFIRM_ID) return this.confirm(from, user);
      if (id === CANCEL_ID) return this.cancel(from);
      return;
    }

    if (message.type === 'audio') {
      await this.api.sendText(from, '🎧 Got it, listening…');
      const audio = await this.api.downloadMedia(message.audio.id);
      const result = await this.voiceService.processAudio(audio, userId);
      // A voice note while an entry waits may be a correction of it.
      const pending = await this.pendingModel.findOne({ phone: from }).exec();
      const said = String(result?.overall_transcript ?? '').trim();
      if (pending && said) {
        return this.applyReply(from, userId, message.id, pending, said, result);
      }
      return this.askToConfirm(from, userId, message.id, result);
    }

    if (message.type === 'text') {
      const text = String(message.text?.body ?? '').trim();
      const lower = text.toLowerCase();
      const pending = await this.pendingModel.findOne({ phone: from }).exec();
      if (pending && YES_WORDS.includes(lower)) return this.confirm(from, user);
      if (pending && NO_WORDS.includes(lower)) return this.cancel(from);
      if (!text || ['hi', 'hello', 'help', 'menu', 'start'].includes(lower)) {
        return this.api.sendText(from, this.helpText(user.shopName || user.name));
      }
      // Anything else while an entry waits is a reply to it: "no, na Kamau".
      if (pending) return this.applyReply(from, userId, message.id, pending, text);
      const result = await this.voiceService.processTranscript({ transcript: text }, userId);
      return this.askToConfirm(from, userId, message.id, result);
    }

    await this.api.sendText(
      from,
      'Send me a voice note (or type it) and I go record am. E.g. "Gani collect 3 akara, 900 naira."',
    );
  }

  /**
   * The trader answered the waiting entry with something other than ✅/❌.
   * The AI decides if it's a fix, a new entry, or unclear. A fix is shown
   * again for ✅: the bot never saves on its own.
   */
  private async applyReply(
    from: string,
    userId: string,
    messageId: string,
    pending: WhatsappPendingDocument,
    reply: string,
    replyResult?: any,
  ): Promise<void> {
    const heard = String(pending.interpretation?.overall_transcript ?? '').trim();
    let revision: Awaited<ReturnType<VoiceService['reviseTranscript']>> = { action: 'new' };
    if (heard) {
      try {
        revision = await this.voiceService.reviseTranscript(heard, reply, userId);
      } catch (error) {
        this.logger.warn(
          `[WhatsApp] correction check failed, treating as new: ${(error as Error).message}`,
        );
      }
    }

    if (revision.action === 'unclear') {
      // The waiting entry stays; the next reply can still fix it.
      return this.api.sendText(from, revision.question);
    }

    if (revision.action === 'correct') {
      const result = await this.voiceService.processTranscript(
        { transcript: revision.transcript },
        userId,
      );
      return this.askToConfirm(from, userId, messageId, result, {
        intro: `Okay, I don change am: "${revision.transcript}"`,
      });
    }

    const result =
      replyResult ??
      (await this.voiceService.processTranscript({ transcript: reply }, userId));
    const hadEntries = (pending.interpretation?.transactions ?? []).length > 0;
    return this.askToConfirm(from, userId, messageId, result, {
      note: hadEntries ? '(I no save the one before. This na new one.)' : undefined,
    });
  }

  /**
   * Keeps what was heard when nothing could be offered for ✅ (no price,
   * unsure customer), so the trader's next reply ("na 1800") can fix it.
   */
  private async rememberHeard(
    from: string,
    userId: string,
    messageId: string,
    result: any,
  ): Promise<void> {
    if (!String(result?.overall_transcript ?? '').trim()) return;
    await this.pendingModel.findOneAndUpdate(
      { phone: from },
      {
        phone: from,
        userId,
        sourceMessageId: messageId,
        interpretation: {
          overall_transcript: result.overall_transcript,
          transactions: [],
        },
        createdAt: new Date(),
      },
      { upsert: true },
    );
  }

  private async askToConfirm(
    from: string,
    userId: string,
    messageId: string,
    result: any,
    options: { intro?: string; note?: string } = {},
  ): Promise<void> {
    const transactions: any[] = result?.transactions ?? [];

    if (
      transactions.length > 0 &&
      transactions.every((t) => t.intent === VoiceIntent.DAILY_SUMMARY)
    ) {
      return this.sendDailySummary(from, userId);
    }

    // No ₦0 debts: a sale heard without any price is sent back, not saved.
    const unpriced = transactions.filter((t) => t.needs_price);
    const recordable = transactions.filter(
      (t) =>
        RECORDABLE.includes(t.intent) &&
        !t.resolvedCustomer?.isAmbiguous &&
        !t.needs_price,
    );
    const ambiguous = transactions.filter((t) => t.resolvedCustomer?.isAmbiguous && RECORDABLE.includes(t.intent));

    if (recordable.length === 0 && unpriced.length) {
      await this.rememberHeard(from, userId, messageId, result);
      return this.api.sendText(
        from,
        `I hear ${this.describe(unpriced[0]).replace(/ owes ₦0/, ' bought something')}, but I no hear the price. Wetin be the total? Reply with am, e.g. "na 1800".`,
      );
    }

    if (recordable.length === 0) {
      const hint = ambiguous.length
        ? `I no sure which customer you mean ("${ambiguous[0].resolvedCustomer?.name}"). Reply with their tag, e.g. "Tunde mechanic".`
        : 'I no understand well well. Abeg talk am again, e.g. "Mama Tunde collect 2 rice, she go pay Friday."';
      if (ambiguous.length) await this.rememberHeard(from, userId, messageId, result);
      return this.api.sendText(from, hint);
    }

    await this.pendingModel.findOneAndUpdate(
      { phone: from },
      {
        phone: from,
        userId,
        sourceMessageId: messageId,
        interpretation: { ...result, transactions: recordable, confirmationAudio: undefined },
        createdAt: new Date(),
      },
      { upsert: true },
    );

    const lines = recordable.map((t, i) => {
      const warnings = (t.warnings ?? []).map((w: string) => `   ⚠️ ${w}`);
      return [`${i + 1}. ${this.describe(t)}`, ...warnings].join('\n');
    });
    const heardLine =
      options.intro ??
      (result?.overall_transcript ? `I heard: "${result.overall_transcript}"` : '');
    const heard = [options.note, heardLine].filter(Boolean).map((l) => `${l}\n\n`).join('');
    const skipped = [
      ambiguous.length
        ? `(Skipped "${ambiguous[0].resolvedCustomer?.name}": not sure which customer.)`
        : '',
      unpriced.length
        ? `(Skipped ${unpriced[0].resolvedCustomer?.name ?? 'one sale'}: no price heard. Send it again with the total.)`
        : '',
    ]
      .filter(Boolean)
      .map((line) => `\n\n${line}`)
      .join('');
    await this.api.sendButtons(
      from,
      `${heard}${lines.join('\n')}${skipped}\n\nMake I save am?`,
      [
        { id: CONFIRM_ID, title: '✅ Save' },
        { id: CANCEL_ID, title: '❌ Cancel' },
      ],
    );
  }

  private async confirm(from: string, user: UserDocument): Promise<void> {
    // Only entries that can be saved are taken; a "what's the price?"
    // question stays so the trader can still answer it.
    const pending = await this.pendingModel
      .findOneAndDelete({ phone: from, 'interpretation.transactions.0': { $exists: true } })
      .exec();
    if (!pending) {
      const waiting = await this.pendingModel.findOne({ phone: from }).exec();
      return this.api.sendText(
        from,
        waiting
          ? 'Nothing is ready to save yet. Tell me the correct name, item or price, or send a new voice note.'
          : 'Nothing is waiting to be saved. Send a new voice note.',
      );
    }
    const userId = user._id.toString();
    const replies: string[] = [];

    const transactions: any[] = pending.interpretation?.transactions ?? [];
    for (const [index, tx] of transactions.entries()) {
      let customerId: string | undefined = tx.resolvedCustomer?.customerId;
      if (!customerId && tx.resolvedCustomer?.isNew) {
        const created = await this.customersService.create(
          { name: tx.resolvedCustomer.name, tag: tx.resolvedCustomer.tag } as any,
          userId,
        );
        customerId = created._id.toString();
      }
      if (!customerId) continue;

      const saved = await this.transactionsService.create(
        {
          customerId,
          type:
            tx.intent === VoiceIntent.PAYMENT
              ? TransactionType.PAYMENT
              : TransactionType.CREDIT,
          items: (tx.items ?? []).map((item: any) => ({
            productName: item.product_name,
            productId: item.product_id ?? undefined,
            quantity: item.quantity,
            unitPriceAtSale: item.unit_price,
          })),
          amount: tx.amount ?? tx.total_amount,
          voiceTranscript: tx.reasoning_summary,
          // Same voice note can never be saved twice, even if ✅ is tapped twice.
          idempotencyKey: `wa-${pending.sourceMessageId}-${index}`,
        },
        userId,
      );

      const customer = await this.customersService.findOne(customerId, userId);
      const receipt = this.receiptService.buildReceiptData(saved, customer, user);
      const receiptUrl = buildPublicReceiptUrl(saved._id.toString());
      const shareUrl = customer.phone
        ? this.receiptService.buildWhatsAppUrl(
            customer.phone,
            this.receiptService.generateWhatsAppMessage(receipt),
          )
        : null;

      replies.push(
        [
          `✅ ${this.describe(tx)}`,
          `${customer.name} now owes ${naira(customer.outstandingBalance)}.`,
          shareUrl
            ? `Send ${customer.name} the receipt: ${shareUrl}`
            : receiptUrl
              ? `Forward this receipt to ${customer.name}: ${receiptUrl}`
              : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    await this.api.sendText(
      from,
      replies.length ? replies.join('\n\n') : 'Nothing was saved. Abeg try again.',
    );
  }

  private async cancel(from: string): Promise<void> {
    await this.pendingModel.deleteOne({ phone: from }).exec();
    await this.api.sendText(from, '❌ Cancelled. Nothing was saved.');
  }

  private async sendDailySummary(from: string, userId: string): Promise<void> {
    const s = await this.transactionsService.getDailySummary(userId);
    await this.api.sendText(
      from,
      `📊 Today (${s.date})\n• Credit given: ${naira(s.totalCredit)} (${s.totalCreditCount})\n• Payments received: ${naira(s.totalRevenue)} (${s.totalRevenueCount})\n• Customers: ${s.uniqueCustomers}`,
    );
  }

  private describe(tx: any): string {
    const name = tx.resolvedCustomer?.name ?? 'Customer';
    const isNew = tx.resolvedCustomer?.isNew ? ' (new customer)' : '';
    const amount = naira(tx.total_amount ?? tx.amount);
    if (tx.intent === VoiceIntent.PAYMENT) {
      return `${name}${isNew} paid ${amount}`;
    }
    const items = (tx.items ?? [])
      .map((i: any) => `${i.quantity} × ${i.product_name}`)
      .join(', ');
    return `${name}${isNew} owes ${amount}${items ? ` for ${items}` : ''}`;
  }

  private helpText(shopName?: string): string {
    return [
      `👋 Welcome to Ledga${shopName ? ` for ${shopName}` : ''}!`,
      '',
      'Send me a voice note in Pidgin, Yoruba or English:',
      '• "Mama Tunde collect 2 granite oil, she go pay Friday"',
      '• "Gani ó ra akara mẹ́ta, ₦900"',
      '• "Kamau don pay 5,000"',
      '• "How today go?" for your daily summary',
      '',
      "I'll show you what I heard, and you tap ✅ to save it.",
    ].join('\n');
  }

  /** True the first time we see this message id. */
  private async markSeen(messageId: string): Promise<boolean> {
    try {
      await this.seenModel.create({ messageId });
      return true;
    } catch (error: any) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }
}
