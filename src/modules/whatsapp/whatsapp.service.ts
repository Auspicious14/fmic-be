import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { VoiceService } from '../voice/voice.service';
import { VoiceIntent } from '../voice/dto/voice-output.dto';
import { CustomersService } from '../customers/customers.service';
import { TransactionsService } from '../transactions/transactions.service';
import { ReceiptData, ReceiptService } from '../transactions/receipt.service';
import { ReceiptImageService } from '../transactions/receipt-image.service';
import {
  LedgerPeriod,
  LedgerQueryService,
  periodRange,
} from '../transactions/ledger-query.service';
import { TransactionType } from '../transactions/schemas/transaction.schema';
import { LAGOS_TIME_ZONE } from '../../common/utils/lagos-time';
import { formatPayout, parsePayoutDetails } from '../../common/utils/banks';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { buildPublicReceiptUrl } from '../../common/utils/signed-link';
import { WhatsappApiService } from './whatsapp-api.service';
import {
  WhatsappPending,
  WhatsappPendingDocument,
  WhatsappSeen,
  WhatsappSeenDocument,
  WhatsappSignup,
  WhatsappSignupDocument,
} from './schemas/whatsapp.schema';

const CONFIRM_ID = 'ledga_confirm';
const CANCEL_ID = 'ledga_cancel';
const YES_WORDS = ['yes', 'y', 'ok', 'okay', 'save', 'correct', 'na so', 'bẹ́ẹ̀ ni', 'beeni', '✅', '👍'];
const NO_WORDS = ['no', 'n', 'cancel', 'wrong', 'no be so', 'rara', 'rárá', '❌'];
const RECORDABLE = [VoiceIntent.CREDIT_SALE, VoiceIntent.PAYMENT];
const VOICE_OFF = ['voice off', 'stop voice', 'no voice', 'text only'];
const VOICE_ON = ['voice on', 'start voice', 'send voice'];

/** "₦1,600" -> "1,600 naira", without emoji or list marks, for the voice reply. */
const speakable = (text: string) =>
  text
    .replace(/₦\s?([\d,]+(?:\.\d+)?)/g, '$1 naira')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[•:]/g, '.')
    .replace(/\s+/g, ' ')
    .trim();

const naira = (amount: number) =>
  `₦${Math.round(Number(amount) || 0).toLocaleString('en-NG')}`;
const shortDate = (date: Date) =>
  new Date(date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', timeZone: LAGOS_TIME_ZONE });
const shortTime = (date: Date) =>
  new Date(date).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: LAGOS_TIME_ZONE });
/** Most lines a list answer shows before "…and N more". */
const LIST_LIMIT = 15;

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
    private readonly receiptImageService: ReceiptImageService,
    private readonly ledgerQueryService: LedgerQueryService,
    @InjectModel(WhatsappSignup.name)
    private readonly signupModel: Model<WhatsappSignupDocument>,
  ) {}

  /** Entry point for the Meta webhook body. */
  async handleWebhook(payload: any): Promise<void> {
    const messages: any[] = [];
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        messages.push(...(change?.value?.messages ?? []));
        this.logFailedDeliveries(change?.value?.statuses ?? []);
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

  /**
   * Meta accepts a reply first and reports delivery later. A reply that was
   * accepted but never reached the phone only shows up here.
   */
  private logFailedDeliveries(statuses: any[]): void {
    for (const status of statuses) {
      if (status?.status !== 'failed') continue;
      const reasons = (status.errors ?? [])
        .map((e: any) => `${e.code} ${e.title}${e.error_data?.details ? `: ${e.error_data.details}` : ''}`)
        .join('; ');
      this.logger.error(
        `[WhatsApp] reply ${status.id} to ${status.recipient_id} was not delivered: ${reasons || 'no reason given'}`,
      );
    }
  }

  async handleMessage(message: any): Promise<void> {
    const from: string = message?.from;
    if (!from || !message?.id) return;
    if (!(await this.markSeen(message.id))) return; // duplicate delivery

    // Blue ticks + "typing…" straight away, so the trader sees we're on it.
    await this.api
      .showTyping(message.id)
      .catch((error) =>
        this.logger.warn(`[WhatsApp] typing indicator: ${(error as Error).message}`),
      );

    const user = await this.userModel.findOne({ whatsappPhone: from }).exec();
    if (!user) return this.signUp(from, message);
    const userId = user._id.toString();

    if (message.type === 'interactive') {
      const id = message.interactive?.button_reply?.id;
      if (id === CONFIRM_ID) return this.confirm(from, user);
      if (id === CANCEL_ID) return this.cancel(from);
      return;
    }

    if (message.type === 'audio') {
      const audio = await this.api.downloadMedia(message.audio.id);
      const result = await this.voiceService.processAudio(audio, userId, { skipTts: true });
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
      if (VOICE_OFF.includes(lower) || VOICE_ON.includes(lower)) {
        const on = VOICE_ON.includes(lower);
        await this.userModel.updateOne({ _id: user._id }, { voiceReplies: on }).exec();
        return this.api.sendText(
          from,
          on
            ? '🔊 Voice replies are on. I go talk back after each entry.'
            : '🔇 Voice replies are off. Send "voice on" to bring them back.',
        );
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
    let transactions: any[] = result?.transactions ?? [];

    if (
      transactions.length > 0 &&
      transactions.every((t) => t.intent === VoiceIntent.DAILY_SUMMARY)
    ) {
      return this.sendDailySummary(from, userId);
    }

    // "My account na OPay 8031234567, …": saved straight away, shown back.
    const payout = transactions.find((t) => t.intent === VoiceIntent.PAYOUT_DETAILS);
    if (payout) {
      await this.api.sendText(from, await this.savePayout(userId, payout.payout ?? {}));
      transactions = transactions.filter((t) => t.intent !== VoiceIntent.PAYOUT_DETAILS);
      if (!transactions.length) return;
    }

    // Questions ("who owe me?") are answered straight away; nothing is saved.
    const questions = transactions.filter((t) => t.intent === VoiceIntent.QUESTION);
    if (questions.length) {
      for (const question of questions) {
        const answer = await this.answerQuestion(userId, question);
        await this.api.sendText(from, answer);
        // Only the headline is spoken: a long list is better read than heard.
        await this.sayAloud(userId, from, answer.split('\n')[0]);
      }
      transactions = transactions.filter((t) => t.intent !== VoiceIntent.QUESTION);
      if (!transactions.length) return;
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
    const spokenEntries = recordable.map((t) => this.describeSpoken(t)).join(' ');
    const check = recordable.some((t) => (t.warnings ?? []).length)
      ? ' Abeg check the message well before you save.'
      : '';
    await this.sayAloud(userId, from, `${spokenEntries}${check} Make I save am?`);
  }

  /** "Alfa owe 1,600 naira for 2 rice." for the voice reply. */
  private describeSpoken(tx: any): string {
    const name = tx.resolvedCustomer?.name ?? 'Customer';
    const amount = `${Math.round(Number(tx.total_amount ?? tx.amount) || 0).toLocaleString('en-NG')} naira`;
    if (tx.intent === VoiceIntent.PAYMENT) return `${name} pay ${amount}.`;
    const items = (tx.items ?? [])
      .map((i: any) => `${i.quantity} ${i.product_name}`)
      .join(', ');
    return `${name} owe ${amount}${items ? ` for ${items}` : ''}.`;
  }

  /**
   * Sends the same reply as a Pidgin voice note, for traders who'd rather
   * listen than read. Never blocks or breaks the text reply.
   */
  private async sayAloud(userId: string, to: string, text: string): Promise<void> {
    try {
      const prefs = await this.userModel.findById(userId).select('voiceReplies').lean().exec();
      if (prefs?.voiceReplies === false) return;
      const audio = await this.voiceService.speak(speakable(text));
      if (audio) await this.api.sendVoice(to, audio);
    } catch (error) {
      this.logger.warn(`[WhatsApp] voice reply not sent: ${(error as Error).message}`);
    }
  }

  /**
   * A number we don't know: sign the trader up right here in the chat.
   * 1. Welcome + ask for their name and shop name.
   * 2. "Bisi, Bisi Provisions" creates the shop (or we ask for the shop name).
   */
  private async signUp(from: string, message: any): Promise<void> {
    const signup = await this.signupModel.findOne({ phone: from }).exec();
    const text = message.type === 'text' ? String(message.text?.body ?? '').trim() : '';

    if (!signup) {
      await this.signupModel.create({ phone: from });
      const appUrl = this.configService.get<string>('APP_URL');
      return this.api.sendText(
        from,
        [
          '👋 Welcome to Ledga! I help you keep record of who owe you, by voice note.',
          '',
          'To start, type your name and your shop name, e.g. "Bisi, Bisi Provisions".',
          appUrl
            ? `\n(Already using Ledga on the web? Add this number in Settings → WhatsApp at ${appUrl} instead.)`
            : '',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      );
    }

    const greeting = ['hi', 'hello', 'hey', 'help', 'menu', 'start'].includes(text.toLowerCase());
    if (!text || greeting) {
      return this.api.sendText(from, 'Abeg type your name and shop name first, e.g. "Bisi, Bisi Provisions".');
    }

    const clean = (value: string) =>
      value
        .replace(/^(my name is|my name na|name na|i be|i'm|i am|na)\s+/i, '')
        .replace(/^(my shop name is|my shop na|shop name na|shop na|my shop is)\s+/i, '')
        .replace(/[."]+$/g, '')
        .trim()
        .slice(0, 60);
    const parts = text
      .split(/\s*(?:,|\n|&|\band\b)\s*/i)
      .map(clean)
      .filter(Boolean);

    let name = signup.name;
    let shopName: string | undefined;
    if (name) {
      shopName = parts.join(' ');
    } else if (parts.length >= 2) {
      [name, shopName] = [parts[0], parts.slice(1).join(' ')];
    } else if (parts.length === 1) {
      await this.signupModel.updateOne({ phone: from }, { name: parts[0] }).exec();
      return this.api.sendText(from, `Nice to meet you, ${parts[0]}! Wetin be your shop name?`);
    }
    if (!name || !shopName) {
      return this.api.sendText(from, 'Abeg type your name and shop name, e.g. "Bisi, Bisi Provisions".');
    }

    // Web login needs an email and password; WhatsApp shops get placeholders
    // until they choose to set them.
    await this.userModel.create({
      email: `wa-${from}@whatsapp.ledga.app`,
      password: await bcrypt.hash(randomBytes(24).toString('hex'), 10),
      name,
      shopName,
      whatsappPhone: from,
      signupSource: 'whatsapp',
    });
    await this.signupModel.deleteOne({ phone: from }).exec();
    return this.api.sendText(from, `✅ You don join Ledga, ${name}!\n\n${this.helpText(shopName)}`);
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
    const spoken: string[] = [];

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

      // The receipt as a picture the trader forwards; its caption (which
      // WhatsApp forwards too) tells the customer how to pay.
      const sentImage = await this.sendReceiptImage(from, receipt);
      const receiptUrl = buildPublicReceiptUrl(saved._id.toString());

      spoken.push(`${customer.name} now owe ${naira(customer.outstandingBalance)}.`);
      replies.push(
        [
          `✅ ${this.describe(tx)}`,
          `${customer.name} now owes ${naira(customer.outstandingBalance)}.`,
          sentImage
            ? `Forward the receipt to ${customer.name}: hold it and tap Forward.`
            : receiptUrl
              ? `Forward this receipt to ${customer.name}: ${receiptUrl}`
              : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    const owesSomething = transactions.some((t) => t.intent === VoiceIntent.CREDIT_SALE);
    const tip =
      replies.length && owesSomething && !user.payoutAccountNumber
        ? '\n\n💡 Tell customers where to pay you: send your account, e.g. "My account na OPay 8031234567, Abdulganiyu Uthman". It will show on every receipt.'
        : '';
    await this.api.sendText(
      from,
      replies.length ? `${replies.join('\n\n')}${tip}` : 'Nothing was saved. Abeg try again.',
    );
    if (spoken.length) await this.sayAloud(userId, from, `I don save am. ${spoken.join(' ')}`);
  }

  private async cancel(from: string): Promise<void> {
    await this.pendingModel.deleteOne({ phone: from }).exec();
    await this.api.sendText(from, '❌ Cancelled. Nothing was saved.');
  }

  /** Sends the receipt PNG. False if it couldn't be drawn or sent. */
  private async sendReceiptImage(to: string, receipt: ReceiptData): Promise<boolean> {
    const png = await this.receiptImageService.render(receipt);
    if (!png) return false;
    const balance = Number(receipt.outstandingBalance) || 0;
    const shop = receipt.businessName;
    const caption =
      receipt.transactionType === 'payment'
        ? `Receipt from ${shop}: payment of ${naira(receipt.totalAmount)} received. ${
            balance > 0 ? `You still owe ${naira(balance)}.` : 'Thank you!'
          }`
        : `Receipt from ${shop}. You owe ${naira(balance)} in total.`;
    const payLine =
      balance <= 0
        ? ''
        : receipt.payTo
          ? `\nPay by transfer: ${formatPayout(receipt.payTo)}`
          : receipt.payUrl
            ? `\nPay online: ${receipt.payUrl}`
            : '';
    try {
      await this.api.sendImage(to, png, `${caption}${payLine}`);
      return true;
    } catch (error) {
      this.logger.warn(`[WhatsApp] receipt image not sent: ${(error as Error).message}`);
      return false;
    }
  }

  /** Saves the trader's own account from a message like "my account na OPay …". */
  private async savePayout(
    userId: string,
    input: { bank?: string; accountNumber?: string; accountName?: string },
  ): Promise<string> {
    const parsed = parsePayoutDetails(input);
    if ('error' in parsed) {
      return `${parsed.error}\nSend am like this: "My account na OPay 8031234567, Abdulganiyu Uthman".`;
    }
    const { bank, accountNumber, accountName } = parsed.details;
    await this.userModel
      .updateOne(
        { _id: userId },
        { payoutBank: bank, payoutAccountNumber: accountNumber, payoutAccountName: accountName },
      )
      .exec();
    return `✅ Saved. Your customers will see this on their receipts:\n🏦 ${formatPayout(parsed.details)}\n\nIf e no correct, send am again.`;
  }

  /** Answers "who owe me?", "how much Kamau owe?", "who pay this week?". */
  async answerQuestion(userId: string, question: any): Promise<string> {
    const topic: string = question.question?.topic ?? 'summary';
    const period = question.question?.period as LedgerPeriod | undefined;
    const more = (n: number) => (n > LIST_LIMIT ? `\n…and ${n - LIST_LIMIT} more` : '');
    const who = (c: { name?: string; tag?: string } | null | undefined) =>
      c ? `${c.name}${c.tag ? ` (${c.tag})` : ''}` : 'Deleted customer';

    if (topic === 'customer_balance') {
      const resolved = question.resolvedCustomer ?? {};
      if (resolved.isAmbiguous) {
        return `I get more than one "${resolved.name}". Add their tag, e.g. "${resolved.name} mechanic".`;
      }
      if (!resolved.customerId) {
        return `I no find "${resolved.name || 'that customer'}" for your book.`;
      }
      const history = await this.ledgerQueryService.customerHistory(userId, resolved.customerId);
      if (!history) return `I no find "${resolved.name}" for your book.`;
      const { customer, recent } = history;
      // Skip ₦0 entries (left over from early testing) so the history reads cleanly.
      const lines = recent.filter((t) => (t.totalAmount || 0) > 0).map((t) => {
        const items = (t.items ?? []).map((i) => `${i.quantity} × ${i.productName}`).join(', ');
        if (t.type === TransactionType.PAYMENT) {
          return `• ${shortDate(t.createdAt)}: paid ${naira(t.totalAmount)}`;
        }
        if (t.type === TransactionType.ADJUSTMENT) {
          return `• ${shortDate(t.createdAt)}: adjusted ${naira(t.totalAmount)}`;
        }
        return `• ${shortDate(t.createdAt)}: took ${items ? `${items}, ` : ''}${naira(t.totalAmount)}`;
      });
      const balance = Number(customer.outstandingBalance) || 0;
      return [
        balance > 0
          ? `${who(customer)} owes you ${naira(balance)}.`
          : `${who(customer)} doesn't owe you anything.`,
        lines.length ? `\nLast entries:\n${lines.join('\n')}` : '',
      ].join('');
    }

    if (topic === 'debtors' && period && period !== 'all') {
      // "Who dey owe me this week": people who took credit then and still owe.
      const range = periodRange(period);
      const { customers, total } = await this.ledgerQueryService.debtorsFrom(userId, range);
      const everyone = await this.ledgerQueryService.debtors(userId);
      const allLine = `\n\nEveryone together owes you ${naira(everyone.total)}. Send "who owe me" for the full list.`;
      if (!customers.length) {
        return `Nobody who took credit ${range.label} still owes you.${everyone.total > 0 ? allLine : ''}`;
      }
      const lines = customers
        .slice(0, LIST_LIMIT)
        .map(
          (c, i) =>
            `${i + 1}. ${who(c)}: owes ${naira(c.outstandingBalance)} (took ${naira(c.takenInPeriod)} ${range.label})`,
        );
      return `📒 ${customers.length} ${customers.length === 1 ? 'customer' : 'customers'} who took credit ${range.label} still owe you ${naira(total)}:\n${lines.join('\n')}${more(customers.length)}${allLine}`;
    }

    if (topic === 'debtors') {
      const { customers, total } = await this.ledgerQueryService.debtors(userId);
      if (!customers.length) return 'Nobody owes you anything right now. 🎉';
      const lines = customers
        .slice(0, LIST_LIMIT)
        .map((c, i) => `${i + 1}. ${who(c)}: ${naira(c.outstandingBalance)}`);
      return `📒 ${customers.length} ${customers.length === 1 ? 'customer owes' : 'customers owe'} you ${naira(total)}:\n${lines.join('\n')}${more(customers.length)}`;
    }

    if (topic === 'payments' || topic === 'sales') {
      const range = periodRange(period ?? 'today');
      const type = topic === 'payments' ? TransactionType.PAYMENT : TransactionType.CREDIT;
      const { entries, total } = await this.ledgerQueryService.entries(userId, type, range);
      if (!entries.length) {
        return topic === 'payments'
          ? `Nobody paid ${range.label}.`
          : `No credit sales ${range.label}.`;
      }
      const when = (d: Date) => (period === 'today' || !period ? shortTime(d) : shortDate(d));
      const lines = entries.slice(0, LIST_LIMIT).map((e) => {
        const items = (e.items ?? []).map((i) => `${i.quantity} × ${i.productName}`).join(', ');
        return `• ${who(e.customer)}: ${naira(e.totalAmount)}${items && topic === 'sales' ? ` (${items})` : ''}, ${when(e.createdAt)}`;
      });
      const title =
        topic === 'payments'
          ? `💰 You collected ${naira(total)} ${range.label}:`
          : `🧾 You gave ${naira(total)} on credit ${range.label}:`;
      return `${title}\n${lines.join('\n')}${more(entries.length)}`;
    }

    // summary
    const range = periodRange(period ?? 'today');
    const [sales, payments, debtors] = await Promise.all([
      this.ledgerQueryService.entries(userId, TransactionType.CREDIT, range),
      this.ledgerQueryService.entries(userId, TransactionType.PAYMENT, range),
      this.ledgerQueryService.debtors(userId),
    ]);
    return [
      `📊 Your shop ${range.label}:`,
      `• Credit given: ${naira(sales.total)} (${sales.entries.length})`,
      `• Money collected: ${naira(payments.total)} (${payments.entries.length})`,
      `• Customers owe you ${naira(debtors.total)} in total`,
    ].join('\n');
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
      '• "Who owe me?" or "How much Kamau owe?"',
      '• "Who pay this week?"',
      '• "My account na OPay 8031234567, Your Name" so customers know where to pay',
      '• "Voice off" if you only want text replies',
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
