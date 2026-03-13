import { Injectable, Logger } from '@nestjs/common';

export interface LanguageDetectionResult {
  language: 'yo' | 'en' | 'mixed';
  confidence: 'high' | 'low';
  raw: string;
}

@Injectable()
export class LanguageDetectionService {
  private readonly logger = new Logger(LanguageDetectionService.name);
  private DETECTION_TIMEOUT: 10000;

  async detectLanguage(
    buffer: Buffer,
    mimeType: string,
  ): Promise<LanguageDetectionResult> {
    try {
      const formData = new FormData();
      formData.append(
        'audio',
        new Blob([new Uint8Array(buffer)]),
        'audio.webm',
      );
      formData.append('mime_type', mimeType);

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.DETECTION_TIMEOUT,
      );

      const response = await fetch(`${process.env.HF_SPACE_URL}/asr/yoruba`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) throw new Error(`Probe failed: ${response.status}`);

      const result = await response.json();
      const transcript: string = result.text ?? '';

      return this.scoreTranscript(transcript);
    } catch (error) {
      this.logger.warn(
        '[LangDetect] Probe failed, defaulting to Yoruba pipeline',
      );
      return { language: 'yo', confidence: 'low', raw: 'probe_failed' };
    }
  }


  private scoreTranscript(transcript: string): LanguageDetectionResult {
    const YORUBA_MARKERS = [
      'gba',
      'jẹ',
      'san',
      'ta',
      'ra',
      'wà',
      'dé',
      'fún',
      'naira',
      'owó',
      'owo',
      'àti',
      'lọ',
      'wọn',
      'naa',
      'náà',
      'ẹ',
      'ọ',
      'ṣ',
      'ǹ',
    ];

    const lower = transcript.toLowerCase();
    let score = YORUBA_MARKERS.filter((marker) =>
      lower.includes(marker),
    ).length;

    const hasDiacritics = /[ẹọṣǹàáâèéêìíîòóôùúû]/.test(transcript);
    if (hasDiacritics) score += 2;

    const englishPatterns =
      /\b(bought|sold|owes|paid|give|owe|for|the|and)\b/gi;
    const englishMatches = (transcript.match(englishPatterns) || []).length;
    if (englishMatches >= 2) score -= 2;

    const wordCount = transcript.trim().split(/\s+/).length;
    const isGarbled = wordCount < 2;

    this.logger.log(
      `[LangDetect] probe="${transcript.substring(0, 60)}" score=${score} words=${wordCount} → ${score >= 2 ? 'yo' : 'en'}`,
    );

    if (isGarbled || score >= 2) {
      return {
        language: 'yo',
        confidence: isGarbled ? 'low' : 'high',
        raw: transcript,
      };
    }
    if (score === 1) {
      return { language: 'mixed', confidence: 'low', raw: transcript };
    }
    return { language: 'en', confidence: 'high', raw: transcript };
  }
}
