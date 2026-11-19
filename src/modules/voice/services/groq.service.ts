import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import { createOptionalRedis } from '../../../common/utils/optional-redis';
import { LLAMA_SYSTEM_PROMPT } from '../constants/prompts';

export interface AsrCandidate {
  text: string;
  confidence: number;
  language: 'yo' | 'en' | 'pcm';
}

@Injectable()
export class GroqService {
  private readonly logger = new Logger(GroqService.name);
  private groq: Groq;
  // Optional: only used to cache LLM parses. Leave REDIS_URL unset on free hosting.
  private redis: Redis | null;
  private readonly model: string;
  private readonly TRANSCRIPTION_TIMEOUT = 60000; // 60s — covers cold start + processing

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
    // llama-3.3-70b-versatile was shut down by Groq on 16 Aug 2026.
    this.model =
      this.configService.get<string>('GROQ_MODEL') || 'openai/gpt-oss-120b';
    this.redis = createOptionalRedis(
      this.configService.get<string>('REDIS_URL'),
      this.logger,
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
      new Blob([new Uint8Array(file)], { type: mimeType }),
      `audio${this.mimeToExt(mimeType)}`,
    );
    formData.append('mime_type', mimeType);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('ASR timeout after 60s')),
        this.TRANSCRIPTION_TIMEOUT,
      ),
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

  // groq.service.ts — new approach for ambiguous cases
  async transcribeWithBestResult(
    file: Buffer,
    mimeType: string,
  ): Promise<{ text: string; confidence: number; language: string }> {
    const candidates = await this.transcribeCandidates(file, mimeType);
    if (candidates.length === 0) throw new Error('Both ASR endpoints failed');
    if (candidates.length === 1) return candidates[0];

    const yoruba = candidates.find((candidate) => candidate.language === 'yo');
    const english = candidates.find((candidate) => candidate.language === 'en');

    if (!yoruba || !english) return candidates[0];

    // Both succeeded — pick winner by scoring transcripts
    const winner = this.pickBetterTranscript(yoruba.text, english.text);
    this.logger.log(
      `[ASR] winner=${winner} | yo="${yoruba.text}" | en="${english.text}"`,
    );

    return winner === 'yo' ? yoruba : english;
  }

  async transcribeCandidates(
    file: Buffer,
    mimeType: string,
  ): Promise<AsrCandidate[]> {
    const [yorubaResult, englishResult] = await Promise.allSettled([
      this.callASREndpoint(file, mimeType, 'yo'),
      this.callASREndpoint(file, mimeType, 'en'),
    ]);

    const yoruba =
      yorubaResult.status === 'fulfilled' ? yorubaResult.value : null;
    const english =
      englishResult.status === 'fulfilled' ? englishResult.value : null;

    const candidates: AsrCandidate[] = [];
    if (yoruba) candidates.push({ ...yoruba, language: 'yo' });
    if (english) candidates.push({ ...english, language: 'en' });

    if (candidates.length === 0) {
      throw new Error('Both ASR endpoints failed');
    }

    return candidates;
  }

  private pickBetterTranscript(
    yorubaText: string,
    englishText: string,
  ): 'yo' | 'en' {
    // Score each transcript for coherence signals

    // Yoruba signals
    const YORUBA_MARKERS = [
      'gba',
      'jẹ',
      'san',
      'ta',
      'ra',
      'fún',
      'ẹ',
      'ọ',
      'ṣ',
      'náà',
      'wọn',
    ];
    const yorubaScore = YORUBA_MARKERS.filter((m) =>
      yorubaText.toLowerCase().includes(m),
    ).length;

    // English/Pidgin signals
    const ENGLISH_MARKERS = [
      'buy',
      'bought',
      'sold',
      'owe',
      'owes',
      'paid',
      'give',
      'the',
      'and',
      'for',
    ];
    const englishScore = ENGLISH_MARKERS.filter((m) =>
      englishText.toLowerCase().includes(m),
    ).length;

    // Diacritics in Yoruba output = strong signal it recognised Yoruba correctly
    const hasDiacritics = /[ẹọṣǹàáèéìíòóùú]/.test(yorubaText);
    const yorubaFinalScore = yorubaScore + (hasDiacritics ? 2 : 0);

    // Prefer English if it has significantly more coherent English words
    // Prefer Yoruba if it has any Yoruba markers OR diacritics
    if (yorubaFinalScore >= 2) return 'yo';
    if (englishScore >= 3) return 'en';

    // Tiebreak: longer transcript usually = better ASR quality on this audio
    return yorubaText.split(' ').length >= englishText.split(' ').length
      ? 'yo'
      : 'en';
  }

  private async callASREndpoint(
    file: Buffer,
    mimeType: string,
    language: 'yo' | 'en',
  ): Promise<{ text: string; confidence: number }> {
    const endpoint =
      language === 'yo'
        ? `${process.env.HF_SPACE_URL}/asr/yoruba`
        : `${process.env.HF_SPACE_URL}/asr/english`;

    const formData = new FormData();
    formData.append(
      'audio',
      new Blob([new Uint8Array(file)], { type: mimeType }),
      `audio${this.mimeToExt(mimeType)}`,
    );
    formData.append('mime_type', mimeType);

    const response = (await Promise.race([
      fetch(endpoint, { method: 'POST', body: formData }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`ASR timeout`)), 60000),
      ),
    ])) as Response;

    if (!response.ok)
      throw new Error(`${language} ASR returned ${response.status}`);
    return response.json();
  }

  async extractStructuredData(
    transcript: string,
    shopContext?: string,
  ): Promise<any> {
    // Key includes the shop context: the same words can resolve differently
    // once a new customer or product exists.
    const cacheKey = `llama_parse:${createHash('sha256')
      .update(`${shopContext ?? ''}\n---\n${transcript}`)
      .digest('hex')}`;
    const cached = await this.cacheGet(cacheKey);
    if (cached) {
      this.logger.log('Returning cached Llama parse result.');
      return JSON.parse(cached);
    }

    const userContent = shopContext
      ? `${shopContext}\n\nTRANSCRIPT:\n${transcript}`
      : transcript;

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const response = await this.groq.chat.completions.create({
          messages: [
            { role: 'system', content: LLAMA_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
        });

        const result = JSON.parse(response.choices[0].message.content || '{}');
        await this.cacheSet(cacheKey, JSON.stringify(result));
        return result;
      } catch (error) {
        attempts++;
        this.logger.error(
          `Groq NLU failed (model=${this.model}, attempt ${attempts}):`,
          (error as Error).message,
        );
        // Only retry what can succeed on retry: rate limits and server errors.
        // A 404 (model gone) or 400 will fail the same way three times.
        const status = (error as { status?: number }).status;
        const retryable = !status || status === 429 || status >= 500;
        if (!retryable || attempts >= maxAttempts) throw error;
        const delay = Math.pow(2, attempts) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async cacheGet(key: string): Promise<string | null> {
    if (!this.redis) return null;
    try {
      return await this.redis.get(key);
    } catch (error) {
      this.logger.warn(`Redis get failed: ${(error as Error).message}`);
      return null;
    }
  }

  private async cacheSet(key: string, value: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, value, 'EX', 86400); // 24h TTL
    } catch (error) {
      this.logger.warn(`Redis set failed: ${(error as Error).message}`);
    }
  }
}
