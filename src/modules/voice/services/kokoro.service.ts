
import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import Redis from 'ioredis';

@Injectable()
export class KokoroService {
  private readonly logger = new Logger(KokoroService.name);
  private readonly redis: Redis;
  private readonly axiosInstance: AxiosInstance;

  // Pre-generated Nigerian Pidgin confirmation phrases mapped to filenames on CDN
  private readonly PRE_GENERATED_PHRASES: Record<string, string> = {
    "I don record am": "confirmation_recorded.wav",
    "Debt don add": "confirmation_debt_added.wav",
    "Payment don enter": "confirmation_payment_entered.wav",
    "Price don change": "confirmation_price_updated.wav",
  };

  constructor(private configService: ConfigService) {
    this.redis = new Redis(this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379');
    
    const kokoroUrl = this.configService.get<string>('KOKORO_TTS_URL') || 'http://localhost:8888';
    this.axiosInstance = axios.create({
      baseURL: kokoroUrl,
      timeout: 5000, // 5 seconds timeout as per production requirements
    });
  }

  /**
   * Generates or retrieves TTS for the given text.
   * Priority: Pre-generated -> Redis Cache -> Real-time Generation
   */
  async generateTTS(text: string, lang: string = 'pcm-NG'): Promise<string> {
    if (!text) {
      throw new HttpException('Text is required for TTS', HttpStatus.BAD_REQUEST);
    }

    try {
      this.logger.log(`Processing TTS for: "${text}" [${lang}]`);

      // 1. Check for pre-generated phrases (CDN/Local storage)
      if (this.PRE_GENERATED_PHRASES[text]) {
        const fileName = this.PRE_GENERATED_PHRASES[text];
        this.logger.log(`Matched pre-generated phrase: ${fileName}`);
        try {
          return await this.fetchFromCDN(fileName);
        } catch (cdnError) {
          this.logger.warn(`Failed to fetch from CDN, falling back to dynamic generation: ${cdnError.message}`);
        }
      }

      // 2. Check Redis cache for dynamic phrases
      const cacheKey = `tts:${Buffer.from(`${text}:${lang}`).toString('base64')}`;
      const cachedAudio = await this.redis.get(cacheKey);
      if (cachedAudio) {
        this.logger.log('Returning cached TTS result.');
        return cachedAudio;
      }

      // 3. Real-time generation via Kokoro service
      const generatedAudio = await this.generateWithRetry(text, lang);
      
      // Cache the result for future use (24h TTL)
      await this.redis.set(cacheKey, generatedAudio, 'EX', 86400);
      
      return generatedAudio;
    } catch (error) {
      this.logger.error(`Kokoro TTS pipeline failed: ${error.message}`);
      
      // Final fallback: Return a silent or very basic error audio if everything fails
      // In a production app, this might be a pre-cached "System Error" audio
      throw new HttpException(
        'Failed to generate voice response',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Fetches pre-generated audio from CDN
   */
  private async fetchFromCDN(fileName: string): Promise<string> {
    const cdnBaseUrl = this.configService.get<string>('CDN_BASE_URL');
    if (!cdnBaseUrl) {
      throw new Error('CDN_BASE_URL is not configured');
    }

    const response = await axios.get(`${cdnBaseUrl}/audio/confirmations/${fileName}`, {
      responseType: 'arraybuffer',
      timeout: 3000,
    });

    return Buffer.from(response.data).toString('base64');
  }

  /**
   * Generates audio using Kokoro service with retry logic
   */
  private async generateWithRetry(text: string, lang: string, attempts: number = 3): Promise<string> {
    let lastError: Error = new Error('Max retries exceeded');
    
    for (let i = 1; i <= attempts; i++) {
      try {
        this.logger.log(`Kokoro TTS generation attempt ${i} for: "${text}"`);
        
        const response = await this.axiosInstance.post('/tts', {
          text,
          lang,
          speed: 1.0,
          format: 'wav'
        });

        // Basic validation of the response
        if (!response.data || !response.data.audio) {
          throw new Error('Invalid response format from Kokoro service');
        }

        return response.data.audio; // Assuming Kokoro returns base64
      } catch (error) {
        lastError = error;
        this.logger.warn(`Kokoro generation attempt ${i} failed: ${error.message}`);
        
        if (i < attempts) {
          const delay = Math.pow(2, i) * 500; // Exponential backoff: 1s, 2s...
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }
}
