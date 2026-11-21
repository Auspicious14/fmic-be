import { Test, TestingModule } from '@nestjs/testing';
import { VoiceService } from './voice.service';
import { ConfigService } from '@nestjs/config';
import { CustomersService } from '../customers/customers.service';
import { ProductsService } from '../products/products.service';
import { TransactionsService } from '../transactions/transactions.service';
import { VoiceIntent } from './dto/voice-output.dto';
import { GroqService } from './services/groq.service';
import { KokoroService } from './services/kokoro.service';
import { CustomerResolverService } from '../customers/customer-resolver.service';
import { LanguageDetectionService } from './services/language-detection.service';
import { AudioPreprocessorService } from './services/audio-preprocessor.service';
import { GeminiService } from './services/gemini.service';
import { SpitchService } from './services/spitch.service';
import { IntronService } from './services/intron.service';

describe('VoiceService', () => {
  let service: VoiceService;

  const mockCustomersService = {
    findAll: jest.fn().mockResolvedValue({
      customers: [
        { _id: 'cust-1', name: 'Babatunde Adekunle', outstandingBalance: 5000 },
      ],
      total: 1,
    }),
  };

  const mockProductsService = {
    findAll: jest.fn().mockResolvedValue([
      {
        _id: 'prod-1',
        name: 'Indomie',
        currentUnitPrice: 150,
        pricingHistory: [],
      },
    ]),
  };

  const mockTransactionsService = {
    getDailySummary: jest.fn().mockResolvedValue([]),
  };

  // Settings the voice pipeline reads; anything else returns 'true' as before.
  let configOverrides: Record<string, string | undefined> = {};
  const mockConfigService = {
    get: jest.fn((key: string) =>
      key in configOverrides ? configOverrides[key] : ['VOICE_PRIMARY', 'ASR_PROVIDERS'].includes(key) ? undefined : 'true',
    ),
  };

  const mockGroqService = {
    transcribe: jest
      .fn()
      .mockResolvedValue({ text: 'mock transcript', confidence: 0.9 }),
    transcribeCandidates: jest.fn().mockResolvedValue([
      {
        text: 'Babatunde Adekunle bought 2 Indomie on credit',
        confidence: 0.9,
        language: 'en',
      },
    ]),
    extractStructuredData: jest.fn().mockResolvedValue({
      transactions: [
        {
          intent: VoiceIntent.CREDIT_SALE,
          data: {
            debtor: 'Babatunde',
            amount: 300,
            items: [{ name: 'Indomie', quantity: 2, price: 150 }],
            type: 'credit',
          },
          confidence_score: 0.9,
          reasoning_summary: 'mock reasoning',
        },
      ],
    }),
  };

  const mockKokoroService = {
    generateTTS: jest.fn().mockResolvedValue('mock_base64'),
  };

  const mockCustomerResolverService = {
    resolve: jest.fn().mockResolvedValue({
      customerId: 'cust-1',
      name: 'Babatunde Adekunle',
      isNew: false,
      isAmbiguous: false,
    }),
  };

  const mockLanguageDetectionService = {
    detectLanguage: jest.fn(),
  };

  const mockAudioPreprocessorService = {
    preprocess: jest.fn().mockImplementation(async (file) => ({
      buffer: file.buffer,
      mimetype: file.mimetype,
      wasProcessed: false,
    })),
  };

  const mockIntronService = {
    isEnabled: jest.fn().mockReturnValue(false),
    transcribeCandidates: jest.fn(),
  };

  const mockSpitchService = {
    isEnabled: jest.fn().mockReturnValue(false),
    transcribeCandidates: jest.fn(),
  };

  const mockGeminiService = {
    isEnabled: jest.fn().mockReturnValue(false),
    extractFromAudio: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGeminiService.isEnabled.mockReturnValue(false);
    mockSpitchService.isEnabled.mockReturnValue(false);
    mockIntronService.isEnabled.mockReturnValue(false);
    configOverrides = {};
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: CustomersService, useValue: mockCustomersService },
        { provide: ProductsService, useValue: mockProductsService },
        { provide: TransactionsService, useValue: mockTransactionsService },
        { provide: GroqService, useValue: mockGroqService },
        { provide: KokoroService, useValue: mockKokoroService },
        {
          provide: CustomerResolverService,
          useValue: mockCustomerResolverService,
        },
        {
          provide: LanguageDetectionService,
          useValue: mockLanguageDetectionService,
        },
        {
          provide: AudioPreprocessorService,
          useValue: mockAudioPreprocessorService,
        },
        { provide: GeminiService, useValue: mockGeminiService },
        { provide: SpitchService, useValue: mockSpitchService },
        { provide: IntronService, useValue: mockIntronService },
      ],
    }).compile();

    service = module.get<VoiceService>(VoiceService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should process transcript correctly with Llama results', async () => {
    const transcript = 'Babatunde Adekunle bought 2 Indomie on credit';
    const result = await service.processTranscript({ transcript }, 'user-id');

    expect(result.transactions[0].intent).toBe(VoiceIntent.CREDIT_SALE);
    expect(result.transactions[0].resolvedCustomer.name).toBe(
      'Babatunde Adekunle',
    );
    expect(result.transactions[0].items[0].product_name).toBe('Indomie');
    expect(result.transactions[0].items[0].quantity).toBe(2);
    expect(result.transactions[0].transaction_type).toBe('credit');
    expect(result.transactions[0].voice_confirmation).toContain(
      'Debt don add for Babatunde Adekunle',
    );
  });

  it('should return correct transaction_type for payments', async () => {
    (service as any).groqService.extractStructuredData.mockResolvedValueOnce({
      transactions: [
        {
          intent: VoiceIntent.PAYMENT,
          data: { debtor: 'Babatunde', amount: 3000, type: 'payment' },
          confidence_score: 0.9,
          reasoning_summary: 'mock reasoning',
        },
      ],
    });

    const result = await service.processTranscript(
      { transcript: 'Babatunde paid 3k' },
      'user-id',
    );
    expect(result.transactions[0].transaction_type).toBe('payment');
  });

  it('should handle missing customer by keeping customerId null but setting customer_name', async () => {
    (service as any).groqService.extractStructuredData.mockResolvedValueOnce({
      transactions: [
        {
          intent: VoiceIntent.CREDIT_SALE,
          data: {
            debtor: 'Unknown Person',
            amount: 500,
            items: [],
            type: 'credit',
          },
          confidence_score: 0.9,
          reasoning_summary: 'mock reasoning',
        },
      ],
    });
    mockCustomerResolverService.resolve.mockResolvedValueOnce({
      name: 'Unknown Person',
      isNew: true,
      isAmbiguous: false,
    });

    const result = await service.processTranscript(
      { transcript: 'Unknown Person bought bread' },
      'user-id',
    );
    expect(result.transactions[0].resolvedCustomer.customerId).toBeUndefined();
    expect(result.transactions[0].resolvedCustomer.name).toBe('Unknown Person');
  });

  it('should preprocess audio and return scored transcription candidates', async () => {
    const result = await service.processAudio(
      { buffer: Buffer.from('audio'), mimetype: 'audio/webm' },
      'user-id',
    );

    expect(mockAudioPreprocessorService.preprocess).toHaveBeenCalled();
    expect(mockGroqService.transcribeCandidates).toHaveBeenCalled();
    expect(result.transcriptionCandidates?.[0].score).toBeGreaterThan(0);
    expect(result.confirmationAudio).toBe('mock_base64');
  });

  it('passes shop context (customer + product names) to the LLM', async () => {
    await service.processTranscript(
      { transcript: 'Baba tunde buy 2 indomie' },
      'user-id',
    );
    const [, context] = mockGroqService.extractStructuredData.mock.calls[0];
    expect(context).toContain('Babatunde Adekunle');
    expect(context).toContain('Indomie | unit price: 150');
  });

  it('computes the total from quantity x price instead of trusting the AI amount', async () => {
    mockGroqService.extractStructuredData.mockResolvedValueOnce({
      transactions: [
        {
          intent: VoiceIntent.CREDIT_SALE,
          data: {
            debtor: 'Babatunde',
            amount: 150, // wrong: AI forgot to multiply
            items: [{ name: 'indomie', quantity: 2, price: 0 }], // price not spoken
          },
          confidence_score: 0.9,
          reasoning_summary: 'mock',
        },
      ],
    });
    const result = await service.processTranscript(
      { transcript: 'x' },
      'user-id',
    );
    expect(result.transactions[0].items[0].unit_price).toBe(150); // from catalogue
    expect(result.transactions[0].items[0].product_name).toBe('Indomie');
    expect(result.transactions[0].total_amount).toBe(300);
  });

  it('keeps the stated amount for payments', async () => {
    mockGroqService.extractStructuredData.mockResolvedValueOnce({
      transactions: [
        {
          intent: VoiceIntent.PAYMENT,
          data: { debtor: 'Babatunde', amount: '2,500' },
          confidence_score: 0.9,
          reasoning_summary: 'mock',
        },
      ],
    });
    const result = await service.processTranscript(
      { transcript: 'x' },
      'user-id',
    );
    expect(result.transactions[0].total_amount).toBe(2500);
  });

  it('uses Gemini audio extraction when enabled and skips the old ASR', async () => {
    mockGeminiService.isEnabled.mockReturnValue(true);
    mockGeminiService.extractFromAudio.mockResolvedValueOnce({
      transcript: 'Baba Tunde collect two Indomie, e go pay Friday',
      language: 'pcm',
      transactions: [
        {
          intent: VoiceIntent.CREDIT_SALE,
          data: {
            debtor: 'Babatunde Adekunle',
            amount: 300,
            items: [{ name: 'Indomie', quantity: 2, price: 150 }],
          },
          confidence_score: 0.92,
          reasoning_summary: 'mock',
        },
      ],
    });

    const result = await service.processAudio(
      { buffer: Buffer.from('audio'), mimetype: 'audio/ogg' },
      'user-id',
    );

    expect(mockGeminiService.extractFromAudio).toHaveBeenCalledWith(
      expect.objectContaining({ mimetype: 'audio/ogg' }),
      expect.stringContaining('Babatunde Adekunle'),
    );
    expect(mockGroqService.transcribeCandidates).not.toHaveBeenCalled();
    expect(result.detectedLanguage).toBe('pcm');
    expect(result.overall_transcript).toContain('collect two Indomie');
    expect(result.transactions[0].total_amount).toBe(300);
    expect(mockKokoroService.generateTTS).toHaveBeenCalledWith(
      expect.stringContaining('Debt don add'),
      'pcm-NG',
    );
  });

  it('falls back to ASR + Llama when Gemini fails (e.g. free-tier 429)', async () => {
    mockGeminiService.isEnabled.mockReturnValue(true);
    mockGeminiService.extractFromAudio.mockRejectedValueOnce(
      new Error('Gemini 429: quota'),
    );

    const result = await service.processAudio(
      { buffer: Buffer.from('audio'), mimetype: 'audio/webm' },
      'user-id',
    );

    expect(mockGroqService.transcribeCandidates).toHaveBeenCalled();
    expect(mockGroqService.extractStructuredData).toHaveBeenCalled();
    expect(result.transactions[0].intent).toBe(VoiceIntent.CREDIT_SALE);
  });

  it('uses Spitch ASR with shop names as hints when Gemini fails', async () => {
    mockGeminiService.isEnabled.mockReturnValue(true);
    mockGeminiService.extractFromAudio.mockRejectedValueOnce(
      new Error('Gemini 503: high demand'),
    );
    mockSpitchService.isEnabled.mockReturnValue(true);
    mockSpitchService.transcribeCandidates.mockResolvedValueOnce([
      { text: 'noise', confidence: 0.8, language: 'en' },
      {
        text: 'Babatunde Adekunle collect two Indomie',
        confidence: 0.8,
        language: 'pcm',
      },
    ]);

    const result = await service.processAudio(
      { buffer: Buffer.from('audio'), mimetype: 'audio/wav' },
      'user-id',
    );

    const [, , hints] = mockSpitchService.transcribeCandidates.mock.calls[0];
    expect(hints).toEqual(expect.arrayContaining(['Babatunde Adekunle', 'Indomie']));
    expect(mockGroqService.transcribeCandidates).not.toHaveBeenCalled();
    expect(result.overall_transcript).toBe('Babatunde Adekunle collect two Indomie');
    expect(result.detectedLanguage).toBe('pcm');
  });

  it('falls back to the HF Space when Spitch fails', async () => {
    mockSpitchService.isEnabled.mockReturnValue(true);
    mockSpitchService.transcribeCandidates.mockRejectedValueOnce(
      new Error('All Spitch ASR calls failed'),
    );

    await service.processAudio(
      { buffer: Buffer.from('audio'), mimetype: 'audio/wav' },
      'user-id',
    );

    expect(mockGroqService.transcribeCandidates).toHaveBeenCalled();
  });

  it('tries Intron before Spitch by default', async () => {
    mockIntronService.isEnabled.mockReturnValue(true);
    mockSpitchService.isEnabled.mockReturnValue(true);
    mockIntronService.transcribeCandidates.mockResolvedValueOnce([
      { text: 'Babatunde Adekunle collect two Indomie', confidence: 0.85, language: 'pcm' },
    ]);

    const result = await service.processAudio(
      { buffer: Buffer.from('audio'), mimetype: 'audio/wav' },
      'user-id',
    );

    expect(mockIntronService.transcribeCandidates).toHaveBeenCalled();
    expect(mockSpitchService.transcribeCandidates).not.toHaveBeenCalled();
    expect(result.overall_transcript).toBe('Babatunde Adekunle collect two Indomie');
  });

  it('falls through Intron -> Spitch when Intron fails', async () => {
    mockIntronService.isEnabled.mockReturnValue(true);
    mockSpitchService.isEnabled.mockReturnValue(true);
    mockIntronService.transcribeCandidates.mockRejectedValueOnce(new Error('Intron 503'));
    mockSpitchService.transcribeCandidates.mockResolvedValueOnce([
      { text: 'Babatunde Adekunle collect Indomie', confidence: 0.8, language: 'pcm' },
    ]);

    await service.processAudio({ buffer: Buffer.from('a'), mimetype: 'audio/wav' }, 'user-id');

    expect(mockSpitchService.transcribeCandidates).toHaveBeenCalled();
    expect(mockGroqService.transcribeCandidates).not.toHaveBeenCalled();
  });

  it('respects ASR_PROVIDERS order', async () => {
    configOverrides.ASR_PROVIDERS = 'spitch,intron';
    mockIntronService.isEnabled.mockReturnValue(true);
    mockSpitchService.isEnabled.mockReturnValue(true);
    mockSpitchService.transcribeCandidates.mockResolvedValueOnce([
      { text: 'Babatunde Adekunle collect Indomie', confidence: 0.8, language: 'pcm' },
    ]);

    await service.processAudio({ buffer: Buffer.from('a'), mimetype: 'audio/wav' }, 'user-id');

    expect(mockSpitchService.transcribeCandidates).toHaveBeenCalled();
    expect(mockIntronService.transcribeCandidates).not.toHaveBeenCalled();
  });

  it('with VOICE_PRIMARY=asr, runs speech-to-text first and only uses Gemini as fallback', async () => {
    configOverrides.VOICE_PRIMARY = 'asr';
    mockGeminiService.isEnabled.mockReturnValue(true);
    mockIntronService.isEnabled.mockReturnValue(true);
    mockIntronService.transcribeCandidates.mockResolvedValueOnce([
      { text: 'Babatunde Adekunle collect Indomie', confidence: 0.85, language: 'yo' },
    ]);

    await service.processAudio({ buffer: Buffer.from('a'), mimetype: 'audio/wav' }, 'user-id');

    expect(mockIntronService.transcribeCandidates).toHaveBeenCalled();
    expect(mockGeminiService.extractFromAudio).not.toHaveBeenCalled();
  });

  it('with VOICE_PRIMARY=asr, uses Gemini when every ASR provider fails', async () => {
    configOverrides.VOICE_PRIMARY = 'asr';
    configOverrides.ASR_PROVIDERS = 'intron';
    mockGeminiService.isEnabled.mockReturnValue(true);
    mockIntronService.isEnabled.mockReturnValue(true);
    mockIntronService.transcribeCandidates.mockRejectedValueOnce(new Error('down'));
    mockGeminiService.extractFromAudio.mockResolvedValueOnce({
      transcript: 'Babatunde collect Indomie',
      language: 'pcm',
      transactions: [],
    });

    const result = await service.processAudio(
      { buffer: Buffer.from('a'), mimetype: 'audio/wav' },
      'user-id',
    );

    expect(mockGeminiService.extractFromAudio).toHaveBeenCalled();
    expect(result.overall_transcript).toBe('Babatunde collect Indomie');
  });

  it('picks the Yoruba reading with real numbers over Pidgin gibberish (log of 20 Nov)', async () => {
    mockIntronService.isEnabled.mockReturnValue(true);
    mockIntronService.transcribeCandidates.mockResolvedValueOnce([
      { text: 'Ora meta ujekan', confidence: 0.85, language: 'pcm' },
      { text: 'Ó ra àkàrà 3, ó jẹ́ 1000', confidence: 0.85, language: 'yo' },
    ]);

    const result = await service.processAudio(
      { buffer: Buffer.from('a'), mimetype: 'audio/wav' },
      'user-id',
    );

    expect(result.overall_transcript).toBe('Ó ra àkàrà 3, ó jẹ́ 1000');
    expect(result.detectedLanguage).toBe('yo');
    // The other reading is passed along so the AI can combine them.
    const [llmInput] = mockGroqService.extractStructuredData.mock.calls[0];
    expect(llmInput).toContain('ALTERNATIVE TRANSCRIPTS');
    expect(llmInput).toContain('Ora meta ujekan');
  });

  it('asks only for the missing name when the sale itself was heard', async () => {
    mockGroqService.extractStructuredData.mockResolvedValueOnce({
      transactions: [
        {
          intent: VoiceIntent.CREDIT_SALE,
          data: { debtor: '', amount: 1000, items: [{ name: 'akara', quantity: 3, price: 0 }] },
          confidence_score: 0.5,
          reasoning_summary: 'no name',
        },
      ],
    });

    const result = await service.processTranscript({ transcript: 'Ó ra àkàrà 3, ó jẹ́ 1000' }, 'user-id');

    expect(result.transactions[0].intent).toBe(VoiceIntent.UNCLEAR);
    expect(result.transactions[0].voice_confirmation).toBe(
      'I hear 3 akara for 1000 naira, but I no catch the customer name. Abeg talk am again with the name.',
    );
  });

  it('shows the per-item price implied by a spoken total in the preview', async () => {
    mockGroqService.extractStructuredData.mockResolvedValueOnce({
      transactions: [
        {
          intent: VoiceIntent.CREDIT_SALE,
          data: { debtor: 'Babatunde', amount: 1000, items: [{ name: 'akara', quantity: 3, price: 0 }] },
          confidence_score: 0.6,
          reasoning_summary: 'Gani bought 3 akara for 1000',
        },
      ],
    });
    const result = await service.processTranscript({ transcript: 'x' }, 'user-id');
    expect(result.transactions[0].total_amount).toBe(1000);
    expect(result.transactions[0].items[0].unit_price).toBe(333.33);
  });

  describe('checks against the ledger', () => {
    const owes = (balance: number) =>
      mockCustomersService.findAll.mockResolvedValueOnce({
        customers: [{ _id: 'cust-1', name: 'Babatunde Adekunle', outstandingBalance: balance }],
        total: 1,
      });
    const heard = (...transactions: any[]) =>
      mockGroqService.extractStructuredData.mockResolvedValueOnce({ transactions });
    const payment = (amount: number, remaining: number | null = null) => ({
      intent: VoiceIntent.PAYMENT,
      data: { debtor: 'Babatunde', amount, remaining_balance: remaining },
      confidence_score: 0.9,
      reasoning_summary: 'payment',
    });

    it('"Kamau don pay 5000, e remain 10000" when he owed nothing: two warnings (20 Nov test)', async () => {
      owes(0);
      heard(payment(5000, 10000));

      const tx = (await service.processTranscript({ transcript: 'x' }, 'user-id')).transactions[0];

      expect(tx.current_balance).toBe(0);
      expect(tx.balance_after).toBe(-5000);
      expect(tx.stated_remaining).toBe(10000);
      expect(tx.warnings).toEqual([
        "Babatunde Adekunle doesn't owe you anything. Saving this puts them ₦5,000 in credit.",
        'You said ₦10,000 remains, but Ledga will have ₦0 owed. Is a debt missing? Record it first.',
      ]);
      expect(tx.voice_confirmation).toContain('Abeg check the screen');
    });

    it('stays quiet when the payment and the remaining amount match the ledger', async () => {
      owes(15000);
      heard(payment(5000, 10000));

      const tx = (await service.processTranscript({ transcript: 'x' }, 'user-id')).transactions[0];

      expect(tx.warnings).toEqual([]);
      expect(tx.balance_after).toBe(10000);
      expect(tx.voice_confirmation).not.toContain('check the screen');
    });

    it('warns when a payment is bigger than what is owed', async () => {
      owes(3000);
      heard(payment(5000));
      const tx = (await service.processTranscript({ transcript: 'x' }, 'user-id')).transactions[0];
      expect(tx.warnings).toEqual([
        'Babatunde Adekunle only owes ₦3,000. Saving this puts them ₦2,000 in credit.',
      ]);
    });

    it('flags a credit sale with no price instead of offering ₦0 (Baba Sola test)', async () => {
      heard({
        intent: VoiceIntent.CREDIT_SALE,
        data: { debtor: 'Babatunde', amount: 0, items: [{ name: 'pick mic', quantity: 2, price: 0 }] },
        confidence_score: 0.55,
        reasoning_summary: 'no price',
      });

      const tx = (await service.processTranscript({ transcript: 'x' }, 'user-id')).transactions[0];

      expect(tx.needs_price).toBe(true);
      expect(tx.total_amount).toBe(0);
      expect(tx.voice_confirmation).toContain('I no hear the price');
    });

    it('chains a sale and a payment in the same voice note', async () => {
      owes(0);
      heard(
        {
          intent: VoiceIntent.CREDIT_SALE,
          data: { debtor: 'Babatunde', amount: 3000, items: [] },
          confidence_score: 0.9,
          reasoning_summary: 'sale',
        },
        payment(1000, 2000),
      );

      const [sale, paid] = (await service.processTranscript({ transcript: 'x' }, 'user-id')).transactions;

      expect(sale.balance_after).toBe(3000);
      expect(paid.current_balance).toBe(3000);
      expect(paid.balance_after).toBe(2000);
      expect(paid.warnings).toEqual([]);
    });
  });

  describe('questions about the records', () => {
    it('"how much Kamau owe?" becomes a QUESTION with the resolved customer, nothing to save', async () => {
      mockGroqService.extractStructuredData.mockResolvedValueOnce({
        transactions: [
          {
            intent: VoiceIntent.QUESTION,
            data: { question: 'customer_balance', debtor: 'Kamau', period: null },
            confidence_score: 0.9,
          },
        ],
      });
      mockCustomerResolverService.resolve.mockResolvedValueOnce({
        customerId: 'c1',
        name: 'Kamau',
        isNew: false,
        isAmbiguous: false,
      });

      const tx = (await service.processTranscript({ transcript: 'how much Kamau owe?' }, 'user-id'))
        .transactions[0];

      expect(tx.intent).toBe(VoiceIntent.QUESTION);
      expect(tx.question).toEqual({ topic: 'customer_balance', period: undefined });
      expect(tx.resolvedCustomer.customerId).toBe('c1');
      expect(tx.total_amount).toBe(0);
    });

    it('"how much Alfa dey owe me" is about Alfa even if the model says summary (21 Nov test)', async () => {
      mockGroqService.extractStructuredData.mockResolvedValueOnce({
        transactions: [{ intent: VoiceIntent.QUESTION, data: { question: 'summary', debtor: 'Alfa', period: 'today' } }],
      });
      mockCustomerResolverService.resolve.mockResolvedValueOnce({
        customerId: 'c9',
        name: 'Alfa',
        isNew: false,
        isAmbiguous: false,
      });
      const tx = (await service.processTranscript({ transcript: 'how much Alfa dey owe me' }, 'user-id'))
        .transactions[0];
      expect(tx.question?.topic).toBe('customer_balance');
    });

    it('"who pay this week?" keeps the period; unknown topics fall back to a summary', async () => {
      mockGroqService.extractStructuredData.mockResolvedValueOnce({
        transactions: [
          { intent: VoiceIntent.QUESTION, data: { question: 'payments', period: 'week' } },
          { intent: VoiceIntent.QUESTION, data: { question: 'weather', period: 'someday' } },
        ],
      });

      const [payments, other] = (await service.processTranscript({ transcript: 'x' }, 'user-id'))
        .transactions;

      expect(payments.question).toEqual({ topic: 'payments', period: 'week' });
      expect(other.question).toEqual({ topic: 'summary', period: undefined });
    });
  });
});
