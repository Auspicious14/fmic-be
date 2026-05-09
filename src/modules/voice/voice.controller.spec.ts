import { Test, TestingModule } from '@nestjs/testing';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';
import { GroqService } from './services/groq.service';
import { KokoroService } from './services/kokoro.service';
import { LanguageDetectionService } from './services/language-detection.service';
import { ThrottlerModule } from '@nestjs/throttler';

describe('VoiceController', () => {
  let controller: VoiceController;

  const mockVoiceService = {
    processTranscript: jest.fn(),
    processAudio: jest.fn(),
  };

  const mockGroqService = {
    transcribe: jest.fn(),
  };

  const mockKokoroService = {
    generateTTS: jest.fn(),
  };

  const mockLanguageDetectionService = {
    detectLanguage: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            ttl: 60000,
            limit: 60,
          },
        ]),
      ],
      controllers: [VoiceController],
      providers: [
        { provide: VoiceService, useValue: mockVoiceService },
        { provide: GroqService, useValue: mockGroqService },
        { provide: KokoroService, useValue: mockKokoroService },
        {
          provide: LanguageDetectionService,
          useValue: mockLanguageDetectionService,
        },
      ],
    }).compile();

    controller = module.get<VoiceController>(VoiceController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
