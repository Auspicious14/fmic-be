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

  const mockConfigService = {
    get: jest.fn().mockReturnValue('true'),
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

  beforeEach(async () => {
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
});
