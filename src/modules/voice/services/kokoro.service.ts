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
    if (lang === 'yo-NG') {
      return this.generateYorubaTTS(text);
    }

    if (!text) {
      throw new HttpException('Text is required for TTS', HttpStatus.BAD_REQUEST);
    }

    try {
      this.logger.log(`[TTS] engine=Kokoro | lang=${lang} | text="${text.substring(0, 50)}"`);

      if (lang === 'yo-NG') {
        try {
          const response = await this.axiosInstance.post('/tts', null, {
            params: { text, lang },
          });

          if (response.status !== 200) {
            throw new Error(`Yoruba TTS failed with status: ${response.status}`);
          }

          return response.data.audio; // Base64 WAV
        } catch (error) {
          this.logger.error(`Yoruba TTS error: ${error.message}`);
          throw new HttpException('Yoruba TTS failed', HttpStatus.INTERNAL_SERVER_ERROR);
        }
      }

      // Existing Kokoro TTS logic
      return await this.generateWithRetry(text, lang);
    } catch (error) {
      this.logger.error(`Kokoro TTS pipeline failed: ${error.message}`);
      throw new HttpException(
        'Failed to generate voice response',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  private async generateYorubaTTS(text: string): Promise<string> {
    try {
      this.logger.log(`[TTS] YarnGPT2b generating for: "${text.substring(0, 60)}..."`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      const response = await fetch(
        `${process.env.HF_SPACE_URL}/tts/yoruba`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        }
      );
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`YarnGPT2b returned ${response.status}`);
      }

      const data = await response.json();
      this.logger.log('[TTS] YarnGPT2b generation successful');
      return data.audio; // base64 WAV

    } catch (error) {
      // Graceful fallback to Kokoro English — never leave user without audio
      this.logger.warn(
        `[TTS] YarnGPT2b failed (${(error as Error).message}), falling back to Kokoro`
      );
      return this.generateTTS(text, 'pcm-NG'); // recursive call with English lang
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
