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

  private mimeToExt(mimeType: string): string {
    const map: Record<string, string> = {
      'audio/webm': '.webm',
      'audio/ogg': '.ogg',
      'audio/wav': '.wav',
      'audio/mpeg': '.mp3',
      'audio/mp4': '.mp4',
      'video/webm': '.webm',
    };
    return map[mimeType] ?? '.webm';
  }

  constructor(private configService: ConfigService) {
    this.groq = new Groq({
      apiKey: this.configService.get<string>('GROQ_API_KEY'),
    });
    this.redis = new Redis(
      this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379',
    );
  }

  // async transcribe(file: Buffer, mimeType: string, language?: 'yo' | 'en'): Promise<{ text: string; confidence: number, language?: string }> {
  //   try {
  //     const fileSizeMB = file.length / (1024 * 1024);
  //     // this.logger.log(`Transcribing audio with Groq Whisper large-v3 [${mimeType}] - Size: ${fileSizeMB.toFixed(2)} MB`);

  //     if (fileSizeMB > 25) {
  //       throw new Error(`Audio file too large (${fileSizeMB.toFixed(2)} MB). Max size is 25MB.`);
  //     }

  //     if (language === 'yo') {
  //       console.log('using yoruba ASR endpoint...')
  //       const formData = new FormData();
  //       formData.append('audio', new Blob([new Uint8Array(file)], { type: mimeType }), 'audio.webm');

  //       const response = await fetch(String(process.env.YORUBA_ASR_URL), {
  //         method: 'POST',
  //         body: formData,
  //       });

  //       if (!response.ok) {
  //         throw new Error(`Yoruba ASR failed: ${response.status}`);
  //       }

  //       const result = await response.json();
  //       return { text: result.text, confidence: result.confidence };
  //     }

  //     // Use groq.toFile for proper multipart encoding of Buffers in Node.js
  //     const fileObj = await Groq.toFile(file, 'audio.webm', { type: mimeType });

  //     const response = await this.groq.audio.transcriptions.create({
  //   file: fileObj,
  //   model: 'whisper-large-v3',
  //   response_format: 'verbose_json',
  //   ...(language ? { language } : {}),
  // });

  // const text = response.text;
  // const confidence = (response as any).confidence ?? 0.8;
  // const detectedLang = (response as any).language ?? 'unknown'; // ← grab it here

  // this.logger.log(`[ASR] model used: Groq Whisper | detected: ${detectedLang}`);
  // return { text, confidence, language: detectedLang }; // ← pass it through
  //   } catch (error) {
  //     this.logger.error('Groq Whisper STT failed:', (error as Error).message);
  //     throw error;
  //   }
  // }

  async transcribe(
    file: Buffer,
    mimeType: string,
    language?: 'yo' | 'en',
  ): Promise<{ text: string; confidence: number; language: string }> {
    const endpoint =
      language === 'yo'
        ? `${process.env.HF_SPACE_URL}/asr/yoruba`
        : `${process.env.HF_SPACE_URL}/asr/english`;

    const formData = new FormData();
    formData.append(
      'audio',
      new Blob([new Uint8Array(file)], { type: mimeType }), // ← type was missing
      `audio${this.mimeToExt(mimeType)}`,
    );
    formData.append('mime_type', mimeType);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('ASR timeout after 15s')), 15000),
    );

    try {
      const response = (await Promise.race([
        fetch(endpoint, {
          method: 'POST',
          body: formData,
        }),
        timeoutPromise,
      ])) as Response;

      if (!response.ok) {
        this.logger.error(
          `[ASR] HuggingFace endpoint error: ${response.status}`,
        );
        throw new Error(`ASR endpoint returned ${response.status}`);
      }

      const result = await response.json();
      this.logger.log(
        `[ASR] model=${result.model} | lang=${language ?? 'en'} | transcript="${result.text}"`,
      );

      return {
        text: result.text,
        confidence: result.confidence ?? 0.8,
        language: language ?? 'en',
      };
    } catch (error) {
      this.logger.error(
        `[ASR] Transcription failed: ${(error as Error).message}`,
      );
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
        this.logger.error(
          `Groq Llama NLU failed (attempt ${attempts}):`,
          (error as Error).message,
        );
        if (attempts >= maxAttempts) throw error;
        const delay = Math.pow(2, attempts) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
