import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AsrCandidate } from './groq.service';

/**
 * Intron Sahara (intron.io) — African speech recognition built for
 * code-switching. Language codes are code-switched models:
 *   yo  = Yoruba-English,  pcm = Pidgin-English,  en = English
 *
 *   POST https://infer.voice.intron.io/file/v1/upload/sync  (multipart)
 *   audio_file_name, audio_file_blob (file), use_language_asr_input,
 *   use_category -> data.audio_transcript
 *
 * Max 120 s of audio per file, 30 requests/minute. Enabled only when
 * INTRON_API_KEY is set.
 */
type IntronLanguage = 'yo' | 'pcm' | 'en';

@Injectable()
export class IntronService {
  private readonly logger = new Logger(IntronService.name);
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly languages: IntronLanguage[];
  private readonly timeoutMs: number;
  private readonly graceMs: number;
  private readonly disableLlmCorrections: boolean;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('INTRON_API_KEY');
    this.baseUrl = (
      this.configService.get<string>('INTRON_BASE_URL') ||
      'https://infer.voice.intron.io'
    ).replace(/\/+$/, '');
    // Each language is one billed call; Pidgin and Yoruba cover most traders.
    this.languages = (
      this.configService.get<string>('INTRON_ASR_LANGUAGES') || 'pcm,yo'
    )
      .split(',')
      .map((l) => l.trim())
      .filter((l): l is IntronLanguage => ['yo', 'pcm', 'en'].includes(l));
    this.graceMs = Number(
      this.configService.get<string>('INTRON_GRACE_MS') || 2500,
    );
    this.timeoutMs = Number(
      this.configService.get<string>('INTRON_TIMEOUT_MS') || 25000,
    );
    this.disableLlmCorrections =
      this.configService.get<string>('INTRON_DISABLE_LLM_CORRECTIONS') === 'true';
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Transcribes the voice note with each configured code-switched model in
   * parallel; VoiceService keeps the transcript that best matches the shop.
   */
  async transcribeCandidates(
    audio: Buffer,
    mimeType: string,
  ): Promise<AsrCandidate[]> {
    if (!this.apiKey) throw new Error('INTRON_API_KEY is not set');

    // The models run in parallel. Once one has answered, the others get
    // INTRON_GRACE_MS more (default 2.5s) instead of holding up the reply.
    const results: Array<{ text?: string; error?: Error } | undefined> = [];
    const tasks = this.languages.map((language, index) =>
      this.transcribe(audio, mimeType, language).then(
        (text) => {
          results[index] = { text };
        },
        (error: Error) => {
          results[index] = { error };
        },
      ),
    );
    const allDone = Promise.all(tasks);
    await Promise.race([
      allDone,
      new Promise<void>((resolve) =>
        tasks.forEach((task, index) =>
          task.then(() => {
            if (results[index]?.text?.trim()) resolve();
          }),
        ),
      ),
    ]);
    let graceTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      allDone,
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, this.graceMs);
      }),
    ]);
    clearTimeout(graceTimer);

    const candidates: AsrCandidate[] = [];
    this.languages.forEach((language, index) => {
      const result = results[index];
      if (result?.text?.trim()) {
        candidates.push({ text: result.text.trim(), confidence: 0.85, language });
      } else if (result?.error) {
        this.logger.warn(`[Intron] ASR ${language} failed: ${result.error.message}`);
      } else if (!result) {
        this.logger.warn(`[Intron] ASR ${language} too slow, went ahead without it`);
      }
    });

    if (candidates.length === 0) throw new Error('All Intron ASR calls failed');
    this.logger.log(
      `[Intron] ASR candidates: ${candidates
        .map((c) => `${c.language}="${c.text.substring(0, 50)}"`)
        .join(' | ')}`,
    );
    return candidates;
  }

  private async transcribe(
    audio: Buffer,
    mimeType: string,
    language: IntronLanguage,
  ): Promise<string> {
    const type = (mimeType || 'audio/wav').split(';')[0];
    const extension = this.extensionFor(type);
    const form = new FormData();
    form.append('audio_file_name', `ledga-voice-note.${extension}`);
    form.append(
      'audio_file_blob',
      new Blob([new Uint8Array(audio)], { type }),
      `voice.${extension}`,
    );
    form.append('use_language_asr_input', language);
    // The API defaults to "telehealth"; trader speech is general.
    form.append('use_category', 'file_category_general');
    if (this.disableLlmCorrections) {
      form.append('use_disable_llm_corrections', 'TRUE');
    }

    const response = await fetch(`${this.baseUrl}/file/v1/upload/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Intron ASR ${response.status}: ${body.slice(0, 200)}`);
    }

    const json = JSON.parse(body);
    const transcript = json?.data?.audio_transcript;
    if (typeof transcript !== 'string') {
      throw new Error(
        `Intron returned no transcript (status ${json?.data?.processing_status ?? json?.status})`,
      );
    }
    return transcript;
  }

  private extensionFor(type: string): string {
    if (type.includes('wav')) return 'wav';
    if (type.includes('ogg')) return 'ogg';
    if (type.includes('webm')) return 'webm';
    if (type.includes('flac')) return 'flac';
    if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
    if (type.includes('m4a') || type.includes('aac')) return 'm4a';
    if (type.includes('mp4')) return 'mp4';
    return 'wav';
  }
}
