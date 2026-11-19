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
  ) {}

  async processAudio(
    file: { buffer: Buffer; mimetype: string },
    userId: string,
  ): Promise<VoiceOutputDto> {
    try {
      const processedAudio =
        await this.audioPreprocessorService.preprocess(file);
      const products = await this.productsService.findAll(userId);
      const { customers } = await this.customersService.findAll(userId);
      const shopContext = buildShopContextBlock(customers, products);

      let transcript = '';
      let detectedLanguage: VoiceOutputDto['detectedLanguage'] = 'en';
      let extraction: { transactions?: any[] } | null = null;
      let scoredCandidates: Array<AsrCandidate & { score: number }> = [];

      // 1. Preferred path: Gemini hears the audio directly (one call, free tier).
      if (this.geminiService.isEnabled()) {
        try {
          const gemini = await this.geminiService.extractFromAudio(
            processedAudio,
            shopContext,
          );
          transcript = gemini.transcript;
          detectedLanguage = gemini.language;
          extraction = { transactions: gemini.transactions };
        } catch (geminiError) {
          this.logger.warn(
            `[VoiceService] Gemini failed, falling back to ASR + Llama: ${(geminiError as Error).message}`,
          );
        }
      }

      // 2. Fallback path: speech-to-text candidates + text LLM.
      // Tries Spitch (Nigerian ASR, if configured) then the Hugging Face Space.
      if (!extraction) {
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
        extraction = await this.groqService.extractStructuredData(
          transcript,
          shopContext,
        );
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
      );

      // Generate TTS audio for the first transaction's confirmation
      // so the frontend can play it back immediately
      const confirmationText = result.transactions[0]?.voice_confirmation ?? '';

      let confirmationAudio: string | null = null;
      if (confirmationText) {
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
    const products = await this.productsService.findAll(userId);
    const { customers } = await this.customersService.findAll(userId);
    const shopContext = buildShopContextBlock(customers, products);

    // 2. NLU with Groq Llama 3.3 70B - returns multiple transactions
    const llamaResult = await this.groqService.extractStructuredData(
      transcript,
      shopContext,
    );
    return this.buildTransactions(transcript, llamaResult, products, userId);
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
  ): Promise<VoiceOutputDto> {
    const rawTransactions = extraction?.transactions || [];
    const processedTransactions: VoiceTransactionData[] = [];

    for (const rawTx of rawTransactions) {
      if (!rawTx.data?.debtor && rawTx.intent !== VoiceIntent.DAILY_SUMMARY) {
        this.logger.warn(
          `[VoiceService] No debtor extracted from transcript: "${transcript}"`,
        );
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
          reasoning_summary: 'Could not extract customer name from transcript',
          voice_confirmation: 'I no understand well well. Abeg talk am again.',
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
      });
    }

    return {
      transactions: processedTransactions,
      overall_transcript: transcript,
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
   * Speech-to-text providers in order: Spitch (if SPITCH_API_KEY is set),
   * then the Hugging Face Space. The first that returns anything wins.
   */
  private async transcribeWithFallbacks(
    original: { buffer: Buffer; mimetype: string },
    processed: { buffer: Buffer; mimetype: string; wasProcessed?: boolean },
    customers: any[],
    products: any[],
  ): Promise<AsrCandidate[]> {
    const errors: string[] = [];

    if (this.spitchService.isEnabled()) {
      try {
        return await this.spitchService.transcribeCandidates(
          processed.buffer,
          processed.mimetype,
          this.buildSpecialWords(customers, products),
        );
      } catch (error) {
        errors.push(`Spitch: ${(error as Error).message}`);
        this.logger.warn(`[VoiceService] Spitch ASR failed, trying HF Space`);
      }
    }

    try {
      return await this.groqService.transcribeCandidates(
        processed.buffer,
        processed.mimetype,
      );
    } catch (error) {
      errors.push(`HF: ${(error as Error).message}`);
      if (processed.wasProcessed) {
        try {
          return await this.groqService.transcribeCandidates(
            original.buffer,
            original.mimetype,
          );
        } catch (retryError) {
          errors.push(`HF original: ${(retryError as Error).message}`);
        }
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
    if (transactionMarkers.some((marker) => text.includes(marker))) score += 8;

    const moneyOrQuantityPattern =
      /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|k|naira|ngn|kan|meji|meta|mẹta|marun)\b/;
    if (moneyOrQuantityPattern.test(text)) score += 6;

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
