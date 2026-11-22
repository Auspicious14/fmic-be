import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AsrCandidate } from './groq.service';

/**
 * Spitch (spitch.app) — Nigerian speech AI for Yoruba, Pidgin, Hausa, Igbo
 * and Nigerian English, in both directions.
 *
 *   POST /v1/transcriptions  multipart {content, language, special_words}
 *   POST /v1/speech          JSON {text, voice, language, format} -> audio
 *
 * Pidgin is `pi` for speech (not `pcm`). Enabled only when SPITCH_API_KEY is set.
 */
type SpitchLanguage = 'yo' | 'pi' | 'en';

const VOICE_BY_LANG: Record<string, string> = {
  yo: 'sade',
  pi: 'ufoma',
  en: 'lucy',
};

const MAX_SPECIAL_WORDS = 100;

@Injectable()
export class SpitchService {
  private readonly logger = new Logger(SpitchService.name);
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly asrLanguages: SpitchLanguage[];
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('SPITCH_API_KEY');
    this.baseUrl = (
      this.configService.get<string>('SPITCH_BASE_URL') ||
      'https://api.spitch.app'
    ).replace(/\/+$/, '');
    // Each language is one transcription call, billed per second of audio.
    this.asrLanguages = (
      this.configService.get<string>('SPITCH_ASR_LANGUAGES') || 'yo,pi,en'
    )
      .split(',')
      .map((l) => l.trim())
      .filter((l): l is SpitchLanguage => ['yo', 'pi', 'en'].includes(l));
    this.timeoutMs = Number(
      this.configService.get<string>('SPITCH_TIMEOUT_MS') || 20000,
    );
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Transcribes the same voice note as Yoruba, Pidgin and English in parallel.
   * VoiceService then keeps the transcript that best matches the shop's
   * customers, products and money words.
   */
  async transcribeCandidates(
    audio: Buffer,
    mimeType: string,
    specialWords: string[] = [],
  ): Promise<AsrCandidate[]> {
    if (!this.apiKey) throw new Error('SPITCH_API_KEY is not set');

    const results = await Promise.allSettled(
      this.asrLanguages.map((language) =>
        this.transcribe(audio, mimeType, language, specialWords),
      ),
    );

    const candidates: AsrCandidate[] = [];
    results.forEach((result, index) => {
      const language = this.asrLanguages[index];
      if (result.status === 'fulfilled' && result.value.trim()) {
        candidates.push({
          text: result.value.trim(),
          confidence: 0.8,
          language: language === 'pi' ? 'pcm' : language,
        });
      } else if (result.status === 'rejected') {
        this.logger.warn(
          `[Spitch] ASR ${language} failed: ${(result.reason as Error).message}`,
        );
      }
    });

    if (candidates.length === 0) throw new Error('All Spitch ASR calls failed');
    this.logger.log(
      `[Spitch] ASR candidates: ${candidates
        .map((c) => `${c.language}="${c.text.substring(0, 50)}"`)
        .join(' | ')}`,
    );
    return candidates;
  }

  /**
   * Returns base64 audio in a Nigerian voice. `lang` is 'yo-NG' or 'pcm-NG'.
   * WAV for the browser; 'ogg_opus' for WhatsApp voice notes.
   */
  async generateSpeech(
    text: string,
    lang: string,
    format: 'wav' | 'ogg_opus' = 'wav',
  ): Promise<string> {
    if (!this.apiKey) throw new Error('SPITCH_API_KEY is not set');
    const isYoruba = lang.startsWith('yo');
    // If the Pidgin code is ever rejected, the Pidgin voice reads it as English.
    const attempts: SpitchLanguage[] = isYoruba ? ['yo'] : ['pi', 'en'];

    let lastError: Error = new Error('Spitch TTS failed');
    for (const language of attempts) {
      try {
        const response = await fetch(`${this.baseUrl}/v1/speech`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            Accept: format === 'wav' ? 'audio/wav' : 'audio/ogg',
          },
          body: JSON.stringify({
            text,
            language,
            voice: this.voiceFor(isYoruba ? 'yo' : 'pi'),
            format,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          throw new Error(
            `Spitch TTS ${response.status}: ${(await response.text()).slice(0, 200)}`,
          );
        }
        const audio = Buffer.from(await response.arrayBuffer());
        this.logger.log(`[Spitch] TTS ok (${language}, ${audio.length} bytes)`);
        return audio.toString('base64');
      } catch (error) {
        lastError = error as Error;
      }
    }
    throw lastError;
  }

  private async transcribe(
    audio: Buffer,
    mimeType: string,
    language: SpitchLanguage,
    specialWords: string[],
  ): Promise<string> {
    const type = (mimeType || 'audio/wav').split(';')[0];
    const form = new FormData();
    form.append(
      'content',
      new Blob([new Uint8Array(audio)], { type }),
      `voice.${this.extensionFor(type)}`,
    );
    form.append('language', language);
    // Bias recognition toward this shop's customer and product names.
    for (const word of specialWords.slice(0, MAX_SPECIAL_WORDS)) {
      form.append('special_words', word);
    }

    const response = await fetch(`${this.baseUrl}/v1/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Spitch ASR ${response.status}: ${body.slice(0, 200)}`);
    }
    return String(JSON.parse(body)?.text ?? '');
  }

  private voiceFor(lang: 'yo' | 'pi'): string {
    const override = this.configService.get<string>(
      lang === 'yo' ? 'SPITCH_VOICE_YO' : 'SPITCH_VOICE_PCM',
    );
    return override || VOICE_BY_LANG[lang];
  }

  private extensionFor(type: string): string {
    if (type.includes('wav')) return 'wav';
    if (type.includes('ogg')) return 'ogg';
    if (type.includes('mp4') || type.includes('m4a') || type.includes('aac'))
      return 'm4a';
    if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
    return 'webm';
  }
}
