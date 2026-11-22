import { ConfigService } from '@nestjs/config';
import { IntronService } from './intron.service';

describe('IntronService', () => {
  const config = (values: Record<string, string>) =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;
  const fetchMock = jest.fn();
  const ok = (transcript: string) =>
    new Response(
      JSON.stringify({
        status: 'Ok',
        data: { processing_status: 'FILE_TRANSCRIBED', audio_transcript: transcript },
      }),
      { status: 200 },
    );

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('is disabled without INTRON_API_KEY', () => {
    expect(new IntronService(config({})).isEnabled()).toBe(false);
  });

  it('calls the sync endpoint with Pidgin and Yoruba code-switched models', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) =>
      ok(`text-${(init.body as FormData).get('use_language_asr_input')}`),
    );
    const service = new IntronService(config({ INTRON_API_KEY: 'k' }));

    const candidates = await service.transcribeCandidates(Buffer.from('wav'), 'audio/wav');

    expect(candidates.map((c) => [c.language, c.text])).toEqual([
      ['pcm', 'text-pcm'],
      ['yo', 'text-yo'],
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://infer.voice.intron.io/file/v1/upload/sync');
    expect(init.headers.Authorization).toBe('Bearer k');
    const form = init.body as FormData;
    expect(form.get('use_category')).toBe('file_category_general');
    expect(form.get('audio_file_blob')).toBeInstanceOf(Blob);
    expect(form.get('use_disable_llm_corrections')).toBeNull();
  });

  it('keeps the languages that succeed', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) =>
      (init.body as FormData).get('use_language_asr_input') === 'yo'
        ? new Response('timeout', { status: 503 })
        : ok('Gani collect akara'),
    );
    const service = new IntronService(config({ INTRON_API_KEY: 'k' }));
    const candidates = await service.transcribeCandidates(Buffer.from('x'), 'audio/ogg');
    expect(candidates).toEqual([{ text: 'Gani collect akara', confidence: 0.85, language: 'pcm' }]);
  });

  it('does not wait long for a slow model once another has answered', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) =>
      (init.body as FormData).get('use_language_asr_input') === 'yo'
        ? new Promise<Response>((resolve) => setTimeout(() => resolve(ok('late')), 2000))
        : ok('Alfa buy two rice'),
    );
    const service = new IntronService(config({ INTRON_API_KEY: 'k', INTRON_GRACE_MS: '50' }));
    const started = Date.now();
    const candidates = await service.transcribeCandidates(Buffer.from('x'), 'audio/ogg');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(candidates).toEqual([{ text: 'Alfa buy two rice', confidence: 0.85, language: 'pcm' }]);
  });

  it('still uses a slower model if it answers within the grace time', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) =>
      (init.body as FormData).get('use_language_asr_input') === 'yo'
        ? new Promise<Response>((resolve) => setTimeout(() => resolve(ok('Alfa ra iresi')), 30))
        : ok('Alfa buy two rice'),
    );
    const service = new IntronService(config({ INTRON_API_KEY: 'k', INTRON_GRACE_MS: '500' }));
    const candidates = await service.transcribeCandidates(Buffer.from('x'), 'audio/ogg');
    expect(candidates.map((c) => c.language)).toEqual(['pcm', 'yo']);
  });

  it('fails when every language fails, so the next provider is tried', async () => {
    fetchMock.mockResolvedValue(new Response('bad', { status: 401 }));
    const service = new IntronService(config({ INTRON_API_KEY: 'k' }));
    await expect(service.transcribeCandidates(Buffer.from('x'), 'audio/wav')).rejects.toThrow(
      'All Intron ASR calls failed',
    );
  });

  it('honours INTRON_ASR_LANGUAGES and INTRON_DISABLE_LLM_CORRECTIONS', async () => {
    fetchMock.mockResolvedValue(ok('hi'));
    const service = new IntronService(
      config({
        INTRON_API_KEY: 'k',
        INTRON_ASR_LANGUAGES: 'yo',
        INTRON_DISABLE_LLM_CORRECTIONS: 'true',
      }),
    );
    await service.transcribeCandidates(Buffer.from('x'), 'audio/wav');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1].body as FormData).get('use_disable_llm_corrections')).toBe('TRUE');
  });
});
