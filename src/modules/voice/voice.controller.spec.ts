
import { Test, TestingModule } from '@nestjs/testing';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';
import { GroqService } from './services/groq.service';
import { KokoroService } from './services/kokoro.service';

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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VoiceController],
      providers: [
        { provide: VoiceService, useValue: mockVoiceService },
        { provide: GroqService, useValue: mockGroqService },
        { provide: KokoroService, useValue: mockKokoroService },
      ],
    }).compile();

    controller = module.get<VoiceController>(VoiceController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
