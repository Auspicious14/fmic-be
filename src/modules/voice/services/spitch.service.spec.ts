import { ConfigService } from '@nestjs/config';
import { SpitchService } from './spitch.service';

describe('SpitchService', () => {
  const config = (values: Record<string, string>) =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('is disabled without SPITCH_API_KEY', () => {
    expect(new SpitchService(config({})).isEnabled()).toBe(false);
  });

  it('transcribes as Yoruba, Pidgin (pi) and English and sends hints', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const lang = (init.body as FormData).get('language');
      return new Response(JSON.stringify({ text: `text-${lang}` }), { status: 200 });
    });
    const service = new SpitchService(config({ SPITCH_API_KEY: 'k' }));

    const candidates = await service.transcribeCandidates(
      Buffer.from('wav'),
      'audio/wav',
      ['Mama Tunde', 'Indomie'],
    );

    expect(candidates.map((c) => c.language)).toEqual(['yo', 'pcm', 'en']);
    expect(candidates[1].text).toBe('text-pi');
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.getAll('special_words')).toEqual(['Mama Tunde', 'Indomie']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.spitch.app/v1/transcriptions');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer k');
  });

  it('keeps the languages that succeed when one fails', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const lang = (init.body as FormData).get('language');
      return lang === 'yo'
        ? new Response('bad', { status: 500 })
        : new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    });
    const service = new SpitchService(config({ SPITCH_API_KEY: 'k' }));
    const candidates = await service.transcribeCandidates(Buffer.from('x'), 'audio/wav');
    expect(candidates.map((c) => c.language)).toEqual(['pcm', 'en']);
  });

  it('speaks Pidgin with a Pidgin voice and returns base64 audio', async () => {
    fetchMock.mockResolvedValue(new Response(Buffer.from('RIFFaudio'), { status: 200 }));
    const service = new SpitchService(config({ SPITCH_API_KEY: 'k' }));

    const audio = await service.generateSpeech('Debt don add', 'pcm-NG');

    expect(Buffer.from(audio, 'base64').toString()).toBe('RIFFaudio');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ language: 'pi', voice: 'ufoma', format: 'wav' });
  });

  it('retries Pidgin speech as English if the pi code is rejected', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('unsupported language', { status: 400 }))
      .mockResolvedValueOnce(new Response(Buffer.from('RIFF'), { status: 200 }));
    const service = new SpitchService(config({ SPITCH_API_KEY: 'k' }));

    await service.generateSpeech('Debt don add', 'pcm-NG');

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).language).toBe('en');
  });
});
