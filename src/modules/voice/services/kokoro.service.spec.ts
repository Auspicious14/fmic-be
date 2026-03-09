
import { Test, TestingModule } from '@nestjs/testing';
import { KokoroService } from './kokoro.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import Redis from 'ioredis';
import { HttpException, HttpStatus } from '@nestjs/common';

jest.mock('axios');
jest.mock('ioredis');

describe('KokoroService', () => {
  let service: KokoroService;
  let configService: ConfigService;
  let redis: jest.Mocked<Redis>;
  let mockedAxios: jest.Mocked<typeof axios>;
  let mockedAxiosInstance: any;

  beforeEach(async () => {
    mockedAxiosInstance = {
      post: jest.fn(),
    };
    (axios.create as jest.Mock).mockReturnValue(mockedAxiosInstance);
    mockedAxios = axios as jest.Mocked<typeof axios>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KokoroService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'REDIS_URL') return 'redis://localhost:6379';
              if (key === 'KOKORO_TTS_URL') return 'http://localhost:8888';
              if (key === 'CDN_BASE_URL') return 'https://cdn.example.com';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<KokoroService>(KokoroService);
    configService = module.get<ConfigService>(ConfigService);
    redis = new Redis() as jest.Mocked<Redis>;
    // The service creates its own Redis instance in constructor, 
    // but we can access it via private property if needed or mock the class
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateTTS', () => {
    it('should throw error if text is empty', async () => {
      await expect(service.generateTTS('')).rejects.toThrow(HttpException);
    });

    it('should fetch from CDN for pre-generated phrases', async () => {
      const text = 'I don record am';
      const mockAudioBuffer = Buffer.from('audio-data');
      const mockBase64 = mockAudioBuffer.toString('base64');

      mockedAxios.get.mockResolvedValueOnce({ data: mockAudioBuffer });

      const result = await service.generateTTS(text);

      expect(result).toBe(mockBase64);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('confirmation_recorded.wav'),
        expect.any(Object)
      );
    });

    it('should return from cache if dynamic text is already in Redis', async () => {
      const text = 'Hello world';
      const mockBase64 = 'cached-audio-base64';
      
      // Accessing private redis for mocking
      (service as any).redis.get.mockResolvedValueOnce(mockBase64);

      const result = await service.generateTTS(text);

      expect(result).toBe(mockBase64);
      expect((service as any).redis.get).toHaveBeenCalled();
      expect(mockedAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('should generate real-time TTS and cache it if not in Redis', async () => {
      const text = 'New dynamic phrase';
      const mockBase64 = 'generated-audio-base64';
      
      (service as any).redis.get.mockResolvedValueOnce(null);
      mockedAxiosInstance.post.mockResolvedValueOnce({
        data: { audio: mockBase64 }
      });

      const result = await service.generateTTS(text);

      expect(result).toBe(mockBase64);
      expect(mockedAxiosInstance.post).toHaveBeenCalledWith('/tts', expect.any(Object));
      expect((service as any).redis.set).toHaveBeenCalledWith(
        expect.any(String),
        mockBase64,
        'EX',
        86400
      );
    });

    it('should retry generation if it fails initially', async () => {
      const text = 'Retry phrase';
      const mockBase64 = 'success-after-retry';

      (service as any).redis.get.mockResolvedValueOnce(null);
      mockedAxiosInstance.post
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ data: { audio: mockBase64 } });

      const result = await service.generateTTS(text);

      expect(result).toBe(mockBase64);
      expect(mockedAxiosInstance.post).toHaveBeenCalledTimes(2);
    });

    it('should throw 500 error if generation fails after all retries', async () => {
      const text = 'Failure phrase';

      (service as any).redis.get.mockResolvedValueOnce(null);
      mockedAxiosInstance.post.mockRejectedValue(new Error('Persistent error'));

      await expect(service.generateTTS(text)).rejects.toThrow(
        new HttpException('Failed to generate voice response', HttpStatus.INTERNAL_SERVER_ERROR)
      );
    });

    it('should fallback to dynamic generation if CDN fetch fails for pre-generated phrase', async () => {
      const text = 'I don record am';
      const mockBase64 = 'fallback-generated-audio';

      mockedAxios.get.mockRejectedValueOnce(new Error('CDN down'));
      (service as any).redis.get.mockResolvedValueOnce(null);
      mockedAxiosInstance.post.mockResolvedValueOnce({
        data: { audio: mockBase64 }
      });

      const result = await service.generateTTS(text);

      expect(result).toBe(mockBase64);
      expect(mockedAxiosInstance.post).toHaveBeenCalled();
    });
  });
});
