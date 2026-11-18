import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GEMINI_AUDIO_SYSTEM_PROMPT } from '../constants/prompts';

export type GeminiLanguage = 'pcm' | 'yo' | 'en' | 'mixed';

export interface GeminiVoiceResult {
  transcript: string;
  language: GeminiLanguage;
  transactions: any[];
}

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
// Inline audio must keep the whole request under ~20MB. Voice notes are tiny,
// but guard anyway so a bad upload fails fast and falls back.
const MAX_INLINE_AUDIO_BYTES = 15 * 1024 * 1024;

/**
 * One call that does speech-to-text AND understanding: the raw voice note plus
 * the shop's customers/products go in, a transcript + structured transactions
 * come out. Uses the Gemini API free tier (key from Google AI Studio).
 *
 * Enabled only when GEMINI_API_KEY is set; otherwise VoiceService keeps using
 * the old Hugging Face ASR + Groq Llama pipeline.
 */
@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('GEMINI_API_KEY');
    this.model =
      this.configService.get<string>('GEMINI_MODEL') || 'gemini-2.5-flash';
    this.timeoutMs = Number(
      this.configService.get<string>('GEMINI_TIMEOUT_MS') || 45000,
    );
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  async extractFromAudio(
    file: { buffer: Buffer; mimetype: string },
    shopContext: string,
  ): Promise<GeminiVoiceResult> {
    if (!this.apiKey) throw new Error('GEMINI_API_KEY is not set');
    if (!file.buffer?.length) throw new Error('Empty audio');
    if (file.buffer.length > MAX_INLINE_AUDIO_BYTES) {
      throw new Error(
        `Audio too large for inline Gemini request (${file.buffer.length} bytes)`,
      );
    }

    const body = {
      systemInstruction: { parts: [{ text: GEMINI_AUDIO_SYSTEM_PROMPT }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: shopContext },
            {
              inlineData: {
                mimeType: this.normalizeMime(file.mimetype),
                data: file.buffer.toString('base64'),
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    };

    const started = Date.now();
    const response = await fetch(
      `${GEMINI_BASE_URL}/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      // 429 = free-tier rate limit hit; caller falls back to the old pipeline.
      throw new Error(`Gemini ${response.status}: ${detail}`);
    }

    const json: any = await response.json();
    const text: string = (json?.candidates?.[0]?.content?.parts ?? [])
      .map((part: any) => part?.text ?? '')
      .join('');
    if (!text) {
      const reason = json?.candidates?.[0]?.finishReason ?? 'no candidates';
      throw new Error(`Gemini returned no text (${reason})`);
    }

    const parsed = this.parseJson(text);
    const result: GeminiVoiceResult = {
      transcript: String(parsed?.transcript ?? '').trim(),
      language: this.normalizeLanguage(parsed?.language),
      transactions: Array.isArray(parsed?.transactions)
        ? parsed.transactions
        : [],
    };

    this.logger.log(
      `[Gemini] model=${this.model} | ${Date.now() - started}ms | lang=${result.language} | tx=${result.transactions.length} | transcript="${result.transcript.substring(0, 80)}"`,
    );
    return result;
  }

  private parseJson(text: string): any {
    try {
      return JSON.parse(text);
    } catch {
      // Occasionally the JSON comes wrapped in ```json fences.
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error('Gemini response was not valid JSON');
    }
  }

  private normalizeLanguage(value: unknown): GeminiLanguage {
    const v = String(value ?? '').toLowerCase();
    if (v === 'yo' || v.startsWith('yor')) return 'yo';
    if (v === 'pcm' || v.includes('pidgin')) return 'pcm';
    if (v === 'en' || v.startsWith('eng')) return 'en';
    return 'mixed';
  }

  private normalizeMime(mimeType: string): string {
    // Browsers sometimes label audio-only recordings as video/*.
    const base = (mimeType || 'audio/wav').split(';')[0].trim().toLowerCase();
    if (base === 'video/webm') return 'audio/webm';
    if (base === 'video/mp4') return 'audio/mp4';
    if (base === 'audio/x-wav' || base === 'audio/wave') return 'audio/wav';
    return base;
  }
}
