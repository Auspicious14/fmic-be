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
import { GroqService } from './services/groq.service';
import { KokoroService } from './services/kokoro.service';
import { CustomerResolverService } from '../customers/customer-resolver.service';

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
  ) {}

  async processAudio(
    file: { buffer: Buffer; mimetype: string },
    userId: string,
  ): Promise<VoiceOutputDto> {
    try {
      // 1. STT with Groq Whisper large-v3
      const { text: transcript } = await this.groqService.transcribe(
        file.buffer,
        file.mimetype,
      );

      return this.processTranscript({ transcript }, userId);
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

    // 1. Gather Context
    const products = await this.productsService.findAll(userId);

    // 2. NLU with Groq Llama 3.3 70B - Now returns multiple transactions
    const llamaResult =
      await this.groqService.extractStructuredData(transcript);
    const rawTransactions = llamaResult.transactions || [];

    const processedTransactions: VoiceTransactionData[] = [];

    for (const rawTx of rawTransactions) {
      // 3. Handle DAILY_SUMMARY intent separately
      if (rawTx.intent === VoiceIntent.DAILY_SUMMARY) {
        const summary = await this.transactionsService.getDailySummary(userId);
        const creditTotal = summary.totalCredit || 0;
        const paymentTotal = summary.totalRevenue || 0;
        const creditCount = summary.totalCreditCount || 0;

        const summaryText = `Today summary: total debt added na ${creditTotal} naira for ${creditCount} customers. Total payments received na ${paymentTotal} naira.`;

        processedTransactions.push({
          intent: VoiceIntent.DAILY_SUMMARY,
          resolvedCustomer: {
            name: 'Shop Owner',
            isNew: false,
            isAmbiguous: false,
          },
          items: [],
          total_amount: creditTotal - paymentTotal,
          transaction_type: 'summary',
          confidence_score: rawTx.confidence_score,
          reasoning_summary: rawTx.reasoning_summary,
          voice_confirmation: summaryText,
        });
        continue;
      }

      // 4. Customer Resolution Pipeline
      const resolvedCustomer = await this.customerResolverService.resolve(
        rawTx.data.debtor,
        rawTx.data.descriptor,
        userId,
      );

      const itemsWithIds = (rawTx.data.items || []).map((item: any) => {
        const itemName = item.name?.toLowerCase().trim() || '';
        const itemWords = itemName
          .split(/\s+/)
          .filter((w: string) => w.length > 2);

        const matchedProduct = products.find((p) => {
          const productName = p.name.toLowerCase();
          if (
            itemName &&
            (productName.includes(itemName) || itemName.includes(productName))
          ) {
            return true;
          }
          if (itemWords.length > 0) {
            return itemWords.some((word: string) => productName.includes(word));
          }
          return false;
        });

        return {
          product_name: item.name,
          product_id: matchedProduct?._id?.toString() || null,
          quantity: item.quantity,
          unit_price: item.price,
        };
      });

      // 5. Generate Voice Confirmation
      let confirmationText = 'I have recorded the transaction.';
      const customerDisplayName =
        resolvedCustomer.name +
        (resolvedCustomer.tag ? ` (${resolvedCustomer.tag})` : '');
      const transactionAmount = rawTx.data.amount || 0;

      if (rawTx.intent === VoiceIntent.CREDIT_SALE) {
        confirmationText = `Debt don add for ${customerDisplayName}. Total na ${transactionAmount} naira.`;
      } else if (rawTx.intent === VoiceIntent.PAYMENT) {
        confirmationText = `Payment don enter for ${customerDisplayName}. Amount na ${transactionAmount} naira.`;
      }

      // 6. Map Intent to Transaction Type
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
}
