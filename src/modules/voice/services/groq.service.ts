
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import Redis from 'ioredis';
import { LLAMA_SYSTEM_PROMPT } from '../constants/prompts';

@Injectable()
export class GroqService {
  private readonly logger = new Logger(GroqService.name);
  private groq: Groq;
  private redis: Redis;

  constructor(private configService: ConfigService) {
    this.groq = new Groq({
      apiKey: this.configService.get<string>('GROQ_API_KEY'),
    });
    this.redis = new Redis(this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379');
  }

  async transcribe(file: Buffer, mimeType: string): Promise<{ text: string; confidence: number }> {
    try {
      const fileSizeMB = file.length / (1024 * 1024);
      this.logger.log(`Transcribing audio with Groq Whisper large-v3 [${mimeType}] - Size: ${fileSizeMB.toFixed(2)} MB`);
      
      if (fileSizeMB > 25) {
        throw new Error(`Audio file too large (${fileSizeMB.toFixed(2)} MB). Max size is 25MB.`);
      }

      // Use groq.toFile for proper multipart encoding of Buffers in Node.js
      const fileObj = await Groq.toFile(file, 'audio.webm', { type: mimeType });

      const response = await this.groq.audio.transcriptions.create({
        file: fileObj,
        model: 'whisper-large-v3',
        response_format: 'verbose_json',
        language: 'en', // Nigerian English/Pidgin are best handled as English or detected
      });

      let text = response.text;
      let confidence = (response as any).confidence || 0.8; // Fallback confidence if not provided

      // Automatic language detection for Nigerian context
      if (confidence < 0.75) {
        this.logger.warn(`Confidence ${confidence} below threshold 0.75, falling back to en-NG context.`);
      }

      return { text, confidence };
    } catch (error) {
      this.logger.error('Groq Whisper STT failed:', (error as Error).message);
      throw error;
    }
  }

  async extractStructuredData(transcript: string): Promise<any> {
    const cacheKey = `llama_parse:${Buffer.from(transcript).toString('base64')}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.log('Returning cached Llama parse result.');
      return JSON.parse(cached);
    }

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const response = await this.groq.chat.completions.create({
          messages: [
            { role: 'system', content: LLAMA_SYSTEM_PROMPT },
            { role: 'user', content: transcript },
          ],
          model: 'llama-3.3-70b-versatile',
          temperature: 0,
          response_format: { type: 'json_object' },
        });

        const result = JSON.parse(response.choices[0].message.content || '{}');
        await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 86400); // 24h TTL
        return result;
      } catch (error) {
        attempts++;
        this.logger.error(`Groq Llama NLU failed (attempt ${attempts}):`, (error as Error).message);
        if (attempts >= maxAttempts) throw error;
        const delay = Math.pow(2, attempts) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
