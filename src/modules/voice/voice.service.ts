import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProcessVoiceDto } from './dto/voice.dto';
import { CustomersService } from '../customers/customers.service';
import { ProductsService } from '../products/products.service';
import {
  VoiceOutputDto,
  VoiceTransactionData,
  VoiceIntent,
} from './dto/voice-output.dto';
import { TransactionsService } from '../transactions/transactions.service';
import { AsrCandidate, GroqService } from './services/groq.service';
import { KokoroService } from './services/kokoro.service';
import { CustomerResolverService } from '../customers/customer-resolver.service';
import { LanguageDetectionService } from './services/language-detection.service';
import { GeminiService } from './services/gemini.service';
import { SpitchService } from './services/spitch.service';
import { IntronService } from './services/intron.service';
import { buildShopContextBlock } from './constants/shop-context';
import { AudioPreprocessorService } from './services/audio-preprocessor.service';

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    private configService: ConfigService,
    private customersService: CustomersService,
    private productsService: ProductsService,
    private transactionsService: TransactionsService,
    private groqService: GroqService,
    private kokoroService: KokoroService,
    private customerResolverService: CustomerResolverService,
    private languageDetectionService: LanguageDetectionService,
    private audioPreprocessorService: AudioPreprocessorService,
    private geminiService: GeminiService,
    private spitchService: SpitchService,
    private intronService: IntronService,
  ) {}

  async processAudio(
    file: { buffer: Buffer; mimetype: string },
    userId: string,
    // WhatsApp sends its own voice note, so it skips the web app's WAV reply.
    options: { skipTts?: boolean } = {},
  ): Promise<VoiceOutputDto> {
    try {
      const [processedAudio, products, { customers }] = await Promise.all([
        this.audioPreprocessorService.preprocess(file),
        this.productsService.findAll(userId),
        this.customersService.findAll(userId),
      ]);
      const shopContext = buildShopContextBlock(customers, products);

      let transcript = '';
      // Assigned inside runGemini/runAsr below, so widen the types explicitly.
      let detectedLanguage = 'en' as VoiceOutputDto['detectedLanguage'];
      let extraction = null as { transactions?: any[] } | null;
      let scoredCandidates: Array<AsrCandidate & { score: number }> = [];

      // Two ways to understand a voice note:
      //  - "gemini": Gemini hears the audio and extracts in one call.
      //  - "asr":    speech-to-text (Intron / Spitch / HF) + text LLM.
      // VOICE_PRIMARY picks which runs first; the other is the fallback.
      const runGemini = async (): Promise<boolean> => {
        if (!this.geminiService.isEnabled()) return false;
        try {
          const gemini = await this.geminiService.extractFromAudio(
            processedAudio,
            shopContext,
          );
          transcript = gemini.transcript;
          detectedLanguage = gemini.language;
          extraction = { transactions: gemini.transactions };
          return true;
        } catch (geminiError) {
          this.logger.warn(
            `[VoiceService] Gemini failed: ${(geminiError as Error).message}`,
          );
          return false;
        }
      };

      const runAsr = async (): Promise<void> => {
        const asrCandidates = await this.transcribeWithFallbacks(
          file,
          processedAudio,
          customers,
          products,
        );
        scoredCandidates = this.rankAsrCandidates(
          asrCandidates,
          products,
          customers,
        );
        const transcriptResult =
          scoredCandidates[0] ??
          (await this.groqService.transcribeWithBestResult(
            file.buffer,
            file.mimetype,
          ));
        transcript = transcriptResult.text;
        detectedLanguage = transcriptResult.language as 'yo' | 'en' | 'pcm';
        // Other models' readings of the same audio often hold what the best
        // one missed (e.g. the Yoruba model got the numbers, another got the name).
        const alternatives = scoredCandidates
          .slice(1, 3)
          .map((c) => c.text)
          .filter((t) => t && t !== transcript);
        const llmInput = alternatives.length
          ? `${transcript}\n\nALTERNATIVE TRANSCRIPTS (same audio, other speech models):\n${alternatives
              .map((t) => `- ${t}`)
              .join('\n')}`
          : transcript;
        extraction = await this.groqService.extractStructuredData(
          llmInput,
          shopContext,
        );
      };

      const primary = this.configService.get<string>('VOICE_PRIMARY') || 'gemini';
      if (primary === 'asr') {
        try {
          await runAsr();
        } catch (asrError) {
          this.logger.warn(
            `[VoiceService] ASR path failed, trying Gemini: ${(asrError as Error).message}`,
          );
          if (!(await runGemini())) throw asrError;
        }
      } else if (!(await runGemini())) {
        await runAsr();
      }

      const ttsLang = detectedLanguage === 'yo' ? 'yo-NG' : 'pcm-NG';
      this.logger.log(
        `[VoiceService] lang=${detectedLanguage} transcript="${transcript}"`,
      );

      const result = await this.buildTransactions(
        transcript,
        extraction ?? {},
        products,
        userId,
        customers,
      );

      // Generate TTS audio for the first transaction's confirmation
      // so the frontend can play it back immediately
      const confirmationText = result.transactions[0]?.voice_confirmation ?? '';

      let confirmationAudio: string | null = null;
      if (confirmationText && !options.skipTts) {
        try {
          confirmationAudio = await this.kokoroService.generateTTS(
            confirmationText,
            ttsLang,
          );
        } catch (ttsError) {
          // TTS failure should NOT fail the whole transaction — log and continue
          this.logger.warn(
            `[VoiceService] TTS failed: ${(ttsError as Error).message}`,
          );
        }
      }

      return {
        ...result,
        detectedLanguage,
        confirmationAudio, // base64 WAV — null if TTS failed
        transcriptionCandidates: scoredCandidates.map((candidate) => ({
          text: candidate.text,
          language: candidate.language,
          confidence: candidate.confidence,
          score: candidate.score,
        })),
      };
    } catch (error) {
      this.logger.error(
        'Audio processing pipeline failed:',
        (error as Error).message,
      );
      throw error;
    }
  }

  async processTranscript(
    processVoiceDto: ProcessVoiceDto,
    userId: string,
  ): Promise<VoiceOutputDto> {
    const { transcript } = processVoiceDto;

    // 1. Gather context so the LLM can use real customer/product spellings
    const [products, { customers }] = await Promise.all([
      this.productsService.findAll(userId),
      this.customersService.findAll(userId),
    ]);
    const shopContext = buildShopContextBlock(customers, products);

    // 2. NLU with Groq Llama 3.3 70B - returns multiple transactions
    const llamaResult = await this.groqService.extractStructuredData(
      transcript,
      shopContext,
    );
    return this.buildTransactions(
      transcript,
      llamaResult,
      products,
      userId,
      customers,
    );
  }

  /** A short Pidgin voice note (OGG/Opus) for WhatsApp, or null if TTS is off or fails. */
  async speak(text: string): Promise<Buffer | null> {
    if (!text.trim() || !this.spitchService.isEnabled()) return null;
    try {
      const base64 = await this.spitchService.generateSpeech(text, 'pcm-NG', 'ogg_opus');
      return Buffer.from(base64, 'base64');
    } catch (error) {
      this.logger.warn(`[VoiceService] voice reply failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * The trader replied to what we heard ("no, na Kamau"). Works out whether
   * the reply fixes it, is a new entry, or is unclear. A fix comes back as a
   * corrected sentence for processTranscript, so every check runs again.
   */
  async reviseTranscript(
    heard: string,
    reply: string,
    userId: string,
  ): Promise<
    | { action: 'correct'; transcript: string }
    | { action: 'new' }
    | { action: 'unclear'; question: string }
  > {
    const products = await this.productsService.findAll(userId);
    const { customers } = await this.customersService.findAll(userId);
    const raw = await this.groqService.reviseTranscript(
      heard,
      reply,
      buildShopContextBlock(customers, products),
    );
    const transcript = String(raw?.transcript ?? '').trim();
    this.logger.log(
      `[VoiceService] correction heard="${heard}" reply="${reply}" -> ${raw?.action} "${transcript}"`,
    );
    if (raw?.action === 'new') return { action: 'new' };
    if (raw?.action === 'correct' && transcript) {
      return { action: 'correct', transcript };
    }
    return {
      action: 'unclear',
      question:
        String(raw?.question ?? '').trim() ||
        'Wetin I go change? Tell me the correct name, item or price.',
    };
  }

  /**
   * Turns raw AI output into resolved, price-checked transactions.
   * Money is computed here (quantity x unit price), never trusted from the AI.
   */
  private async buildTransactions(
    transcript: string,
    extraction: { transactions?: any[] },
    products: any[],
    userId: string,
    customers: any[] = [],
  ): Promise<VoiceOutputDto> {
    const rawTransactions = extraction?.transactions || [];
    const processedTransactions: VoiceTransactionData[] = [];
    // Running balance per customer, so a sale then a payment in one voice
    // note are checked against each other.
    const runningBalance = new Map<string, number>();

    for (const rawTx of rawTransactions) {
      if (rawTx.intent === VoiceIntent.QUESTION) {
        processedTransactions.push(await this.buildQuestion(rawTx, userId));
        continue;
      }
      if (rawTx.intent === VoiceIntent.PAYOUT_DETAILS) {
        processedTransactions.push({
          intent: VoiceIntent.PAYOUT_DETAILS,
          resolvedCustomer: { name: '', isNew: false, isAmbiguous: false },
          items: [],
          total_amount: 0,
          transaction_type: 'payout_details',
          confidence_score: rawTx.confidence_score ?? 0,
          reasoning_summary: rawTx.reasoning_summary ?? '',
          payout: {
            bank: rawTx.data?.bank ?? undefined,
            accountNumber:
              rawTx.data?.account_number != null ? String(rawTx.data.account_number) : undefined,
            accountName: rawTx.data?.account_name ?? undefined,
          },
          warnings: [],
        });
        continue;
      }
      if (!rawTx.data?.debtor && rawTx.intent !== VoiceIntent.DAILY_SUMMARY) {
        this.logger.warn(
          `[VoiceService] No debtor extracted from transcript: "${transcript}"`,
        );
        // If the sale itself was understood, say what we heard and ask only
        // for the missing name, instead of a generic "talk am again".
        const heardItems = (rawTx.data?.items || [])
          .map((i: any) => `${i.quantity ?? ''} ${i.name ?? ''}`.trim())
          .filter(Boolean)
          .join(', ');
        const heardAmount = this.toPositiveNumber(rawTx.data?.amount);
        const heardSomething = heardItems || heardAmount;
        const heardText = [
          heardItems,
          heardAmount ? `${heardAmount} naira` : '',
        ]
          .filter(Boolean)
          .join(' for ');
        processedTransactions.push({
          intent: VoiceIntent.UNCLEAR,
          resolvedCustomer: {
            name: 'Unknown',
            isNew: false,
            isAmbiguous: true,
          },
          items: [],
          total_amount: 0,
          transaction_type: 'unclear',
          confidence_score: 0,
          reasoning_summary: heardSomething
            ? `Heard a sale (${heardText}) but no customer name`
            : 'Could not extract customer name from transcript',
          voice_confirmation: heardSomething
            ? `I hear ${heardText}, but I no catch the customer name. Abeg talk am again with the name.`
            : 'I no understand well well. Abeg talk am again.',
        });
        continue; // skip to next transaction, don't crash
      }

      // Customer Resolution Pipeline
      const resolvedCustomer = await this.customerResolverService.resolve(
        rawTx.data.debtor,
        rawTx.data.descriptor,
        userId,
      );

      const itemsWithIds = (rawTx.data.items || []).map((item: any) => {
        const matchedProduct = this.matchProduct(item.name, products);
        const quantity = this.toPositiveNumber(item.quantity) || 1;
        const spokenPrice = this.toPositiveNumber(item.price);
        const unitPrice =
          spokenPrice ||
          this.toPositiveNumber(matchedProduct?.currentUnitPrice);

        return {
          product_name: matchedProduct?.name ?? item.name,
          product_id: matchedProduct?._id?.toString() || null,
          quantity,
          unit_price: unitPrice,
        };
      });

      const transactionAmount = this.computeAmount(
        rawTx,
        itemsWithIds,
        transcript,
      );

      // Trader gave only a total ("3 akara, 1000"): show the per-item price it
      // implies, so the preview doesn't say ₦0.
      type PricedItem = { quantity: number; unit_price: number };
      const unpricedItems = (itemsWithIds as PricedItem[]).filter((i) => !(i.unit_price > 0));
      if (transactionAmount > 0 && unpricedItems.length > 0) {
        const pricedTotal = (itemsWithIds as PricedItem[])
          .filter((i) => i.unit_price > 0)
          .reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
        const unpricedUnits = unpricedItems.reduce((sum, i) => sum + i.quantity, 0);
        const perUnit = Math.max(transactionAmount - pricedTotal, 0) / unpricedUnits;
        for (const item of unpricedItems) {
          item.unit_price = Math.round(perUnit * 100) / 100;
        }
      }

      // Generate Voice Confirmation
      let confirmationText = 'I have recorded the transaction.';
      const customerDisplayName =
        resolvedCustomer.name +
        (resolvedCustomer.tag ? ` (${resolvedCustomer.tag})` : '');

      if (rawTx.intent === VoiceIntent.CREDIT_SALE) {
        confirmationText = `Debt don add for ${customerDisplayName}. Total na ${transactionAmount} naira.`;
      } else if (rawTx.intent === VoiceIntent.PAYMENT) {
        confirmationText = `Payment don enter for ${customerDisplayName}. Amount na ${transactionAmount} naira.`;
      }

      // Map Intent to Transaction Type
      let transactionType = 'credit';
      if (rawTx.intent === VoiceIntent.PAYMENT) {
        transactionType = 'payment';
      } else if (rawTx.intent === VoiceIntent.ADJUSTMENT) {
        transactionType = 'adjustment';
      }

      const checks = this.checkAgainstLedger(
        rawTx,
        resolvedCustomer,
        customerDisplayName,
        transactionAmount,
        customers,
        runningBalance,
      );
      if (checks.needs_price) {
        confirmationText = `I hear the sale for ${customerDisplayName}, but I no hear the price. Abeg type the total.`;
      } else if (checks.warnings.length) {
        confirmationText = `${confirmationText} Abeg check the screen before you save.`;
      }

      processedTransactions.push({
        intent: rawTx.intent as VoiceIntent,
        resolvedCustomer,
        items: itemsWithIds,
        total_amount: transactionAmount,
        amount: transactionAmount, // Explicitly pass amount for non-itemized transactions
        transaction_type: transactionType,
        confidence_score: rawTx.confidence_score,
        reasoning_summary: rawTx.reasoning_summary,
        voice_confirmation: confirmationText,
        ...checks,
      });
    }

    return {
      transactions: processedTransactions,
      overall_transcript: transcript,
    };
  }

  /** A question about the records ("how much Kamau owe?"): nothing to save. */
  private async buildQuestion(
    rawTx: any,
    userId: string,
  ): Promise<VoiceTransactionData> {
    const topics = ['debtors', 'customer_balance', 'payments', 'sales', 'summary'];
    const periods = ['today', 'yesterday', 'week', 'month', 'all'];
    const name = String(rawTx.data?.debtor ?? '').trim();
    let topic = topics.includes(rawTx.data?.question) ? rawTx.data.question : 'summary';
    // A named customer means "how much does X owe", whatever topic was guessed;
    // "how much does … owe" with no name means the debtors list.
    if (name && (topic === 'debtors' || topic === 'summary')) topic = 'customer_balance';
    if (!name && topic === 'customer_balance') topic = 'debtors';
    const resolvedCustomer = name
      ? await this.customerResolverService.resolve(name, rawTx.data?.descriptor, userId)
      : { name: '', isNew: false, isAmbiguous: false };
    return {
      intent: VoiceIntent.QUESTION,
      resolvedCustomer,
      items: [],
      total_amount: 0,
      transaction_type: 'question',
      confidence_score: rawTx.confidence_score ?? 0,
      reasoning_summary: rawTx.reasoning_summary ?? '',
      question: {
        topic,
        period: periods.includes(rawTx.data?.period) ? rawTx.data.period : undefined,
      },
      warnings: [],
    };
  }

  /**
   * Compares what was heard with what the ledger already knows, so the trader
   * sees a problem before saving rather than in an argument later:
   *  - a credit sale with no price at all (would save as ₦0)
   *  - a payment bigger than what the customer owes
   *  - "e remain 10000" when the ledger says something else
   */
  private checkAgainstLedger(
    rawTx: any,
    resolvedCustomer: { customerId?: string; isNew?: boolean; isAmbiguous?: boolean },
    displayName: string,
    amount: number,
    customers: any[],
    runningBalance: Map<string, number>,
  ): {
    warnings: string[];
    needs_price?: boolean;
    current_balance?: number;
    balance_after?: number;
    stated_remaining?: number;
  } {
    const warnings: string[] = [];
    const naira = (n: number) => `₦${Math.round(n).toLocaleString('en-NG')}`;
    const isCredit = rawTx.intent === VoiceIntent.CREDIT_SALE;
    const isPayment = rawTx.intent === VoiceIntent.PAYMENT;

    if (isCredit && !(amount > 0)) {
      warnings.push('No price was heard. Type the total before saving.');
      return { warnings, needs_price: true };
    }
    if ((!isCredit && !isPayment) || resolvedCustomer.isAmbiguous) {
      return { warnings };
    }

    // Balance before this entry: known customers from the ledger, new ones start at 0.
    const key = resolvedCustomer.customerId ?? `new:${displayName.toLowerCase()}`;
    let before = runningBalance.get(key);
    if (before === undefined) {
      const existing = resolvedCustomer.customerId
        ? customers.find((c) => c?._id?.toString() === resolvedCustomer.customerId)
        : undefined;
      if (resolvedCustomer.customerId && !existing) return { warnings };
      before = Number(existing?.outstandingBalance) || 0;
    }
    const after = isCredit ? before + amount : before - amount;
    runningBalance.set(key, after);

    if (isPayment && amount > before) {
      warnings.push(
        before <= 0
          ? `${displayName} doesn't owe you anything. Saving this puts them ${naira(amount - before)} in credit.`
          : `${displayName} only owes ${naira(before)}. Saving this puts them ${naira(amount - before)} in credit.`,
      );
    }

    const statedRaw = rawTx.data?.remaining_balance;
    const stated =
      statedRaw === null || statedRaw === undefined || statedRaw === ''
        ? undefined
        : Number(String(statedRaw).replace(/,/g, ''));
    const hasStated = stated !== undefined && Number.isFinite(stated) && stated >= 0;
    if (hasStated && Math.abs((stated as number) - after) >= 1) {
      warnings.push(
        (stated as number) > after
          ? `You said ${naira(stated as number)} remains, but Ledga will have ${naira(Math.max(after, 0))} owed. Is a debt missing? Record it first.`
          : `You said ${naira(stated as number)} remains, but Ledga will have ${naira(after)} owed. Check the amounts.`,
      );
    }

    return {
      warnings,
      current_balance: before,
      balance_after: after,
      ...(hasStated ? { stated_remaining: stated } : {}),
    };
  }

  /**
   * Credit sale with priced items -> sum of quantity x unit price.
   * Otherwise (payments, or the trader only said a total) -> the stated amount.
   */
  private computeAmount(
    rawTx: any,
    items: Array<{ quantity: number; unit_price: number }>,
    transcript: string,
  ): number {
    const statedAmount = this.toPositiveNumber(rawTx.data?.amount);
    const allItemsPriced =
      items.length > 0 && items.every((item) => item.unit_price > 0);

    if (rawTx.intent === VoiceIntent.CREDIT_SALE && allItemsPriced) {
      const itemsTotal = items.reduce(
        (sum, item) => sum + item.quantity * item.unit_price,
        0,
      );
      if (statedAmount && statedAmount !== itemsTotal) {
        this.logger.warn(
          `[VoiceService] AI amount ${statedAmount} != items total ${itemsTotal}; using items total. transcript="${transcript}"`,
        );
      }
      return itemsTotal;
    }
    return statedAmount;
  }

  /** Exact name first, then substring, then best word overlap. */
  private matchProduct(itemName: string, products: any[]): any | undefined {
    const name = this.normalizeForVoiceMatching(itemName);
    if (!name || !products?.length) return undefined;

    const normalized = products.map((product) => ({
      product,
      name: this.normalizeForVoiceMatching(product.name),
    }));

    const exact = normalized.find((p) => p.name === name);
    if (exact) return exact.product;

    const contains = normalized.find(
      (p) => p.name && (p.name.includes(name) || name.includes(p.name)),
    );
    if (contains) return contains.product;

    const itemWords = name.split(' ').filter((w) => w.length > 2);
    let best: { product: any; score: number } | undefined;
    for (const p of normalized) {
      const productWords = new Set(p.name.split(' '));
      const score = itemWords.filter((w) => productWords.has(w)).length;
      if (score > 0 && (!best || score > best.score)) {
        best = { product: p.product, score };
      }
    }
    return best?.product;
  }

  private toPositiveNumber(value: unknown): number {
    const n =
      typeof value === 'string'
        ? Number(value.replace(/,/g, ''))
        : Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * Speech-to-text providers in ASR_PROVIDERS order (Intron, Spitch, then the
   * Hugging Face Space by default). The first that returns anything wins.
   */
  private async transcribeWithFallbacks(
    original: { buffer: Buffer; mimetype: string },
    processed: { buffer: Buffer; mimetype: string; wasProcessed?: boolean },
    customers: any[],
    products: any[],
  ): Promise<AsrCandidate[]> {
    const errors: string[] = [];
    // Order from ASR_PROVIDERS (default intron,spitch,hf); unconfigured ones are skipped.
    const order = (
      this.configService.get<string>('ASR_PROVIDERS') || 'intron,spitch,hf'
    )
      .split(',')
      .map((p) => p.trim().toLowerCase());

    for (const provider of order) {
      try {
        if (provider === 'intron' && this.intronService.isEnabled()) {
          return await this.intronService.transcribeCandidates(
            processed.buffer,
            processed.mimetype,
          );
        }
        if (provider === 'spitch' && this.spitchService.isEnabled()) {
          return await this.spitchService.transcribeCandidates(
            processed.buffer,
            processed.mimetype,
            this.buildSpecialWords(customers, products),
          );
        }
        if (provider === 'hf') {
          try {
            return await this.groqService.transcribeCandidates(
              processed.buffer,
              processed.mimetype,
            );
          } catch (error) {
            if (!processed.wasProcessed) throw error;
            return await this.groqService.transcribeCandidates(
              original.buffer,
              original.mimetype,
            );
          }
        }
      } catch (error) {
        errors.push(`${provider}: ${(error as Error).message}`);
        this.logger.warn(`[VoiceService] ${provider} ASR failed, trying next`);
      }
    }

    throw new Error(`All speech-to-text providers failed (${errors.join('; ')})`);
  }

  /** Customer names, nicknames and product names, used as ASR hints. */
  private buildSpecialWords(customers: any[], products: any[]): string[] {
    const words = new Set<string>();
    for (const customer of customers || []) {
      [customer.name, ...(customer.aliases || [])]
        .filter(Boolean)
        .forEach((w: string) => words.add(String(w).trim()));
    }
    for (const product of products || []) {
      if (product?.name) words.add(String(product.name).trim());
    }
    return [...words].filter((w) => w.length > 1);
  }

  private rankAsrCandidates(
    candidates: AsrCandidate[],
    products: any[],
    customers: any[],
  ): Array<AsrCandidate & { score: number }> {
    return candidates
      .map((candidate) => ({
        ...candidate,
        score: this.scoreAsrCandidate(candidate, products, customers),
      }))
      .sort((a, b) => b.score - a.score);
  }

  private scoreAsrCandidate(
    candidate: AsrCandidate,
    products: any[],
    customers: any[],
  ): number {
    const text = this.normalizeForVoiceMatching(candidate.text);
    const words = text.split(/\s+/).filter(Boolean);
    let score = (candidate.confidence ?? 0.5) * 10;

    if (!text || words.length < 2) score -= 20;

    const transactionMarkers = [
      'bought',
      'buy',
      'paid',
      'pay',
      'owe',
      'owes',
      'credit',
      'debt',
      'book',
      'put am',
      'give',
      'collect',
      'san',
      'gba',
      'ra',
      'ta',
      'owo',
      'owó',
      'don',
      'dey',
      'carry',
      'take',
    ];
    // Whole words only: "ra" (bought) must not match inside "Ora" or "akara".
    const wordSet = new Set(words);
    const textWithSpaces = ` ${text} `;
    if (
      transactionMarkers.some((marker) =>
        marker.includes(' ')
          ? textWithSpaces.includes(` ${marker} `)
          : wordSet.has(marker),
      )
    ) {
      score += 8;
    }

    // Real figures are the strongest sign a transcript is usable.
    const digitGroups = text.match(/\d+/g) ?? [];
    score += Math.min(digitGroups.length, 3) * 3;
    if (digitGroups.some((d) => Number(d) >= 50)) score += 4; // looks like naira
    const numberWords = [
      'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
      'ten', 'hundred', 'thousand', 'naira', 'ngn', 'kan', 'meji', 'meta',
      'merin', 'marun', 'egberun', 'ogorun',
    ];
    if (words.some((w) => numberWords.includes(w))) score += 3;

    for (const customer of customers || []) {
      const names = [
        customer.name,
        customer.tag,
        ...(customer.aliases || []),
      ].filter(Boolean);
      if (
        names.some((name) => {
          const normalizedName = this.normalizeForVoiceMatching(name);
          const firstName = normalizedName.split(/\s+/)[0];
          return (
            normalizedName.length > 2 &&
            (text.includes(normalizedName) ||
              (firstName.length > 2 && text.includes(firstName)))
          );
        })
      ) {
        score += 10;
        break;
      }
    }

    for (const product of products || []) {
      const productName = this.normalizeForVoiceMatching(product.name);
      const productWords = productName
        .split(/\s+/)
        .filter((word) => word.length > 2);
      if (
        productName.length > 2 &&
        (text.includes(productName) ||
          productWords.some((word) => text.includes(word)))
      ) {
        score += 8;
        break;
      }
    }

    const uniqueWords = new Set(words);
    if (words.length > 4 && uniqueWords.size <= 2) score -= 10;

    return score;
  }

  private normalizeForVoiceMatching(value: string): string {
    return (value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9₦\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
