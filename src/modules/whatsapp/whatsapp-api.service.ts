import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Thin client for the WhatsApp Cloud API (graph.facebook.com).
 * Needs WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID from Meta's developer
 * dashboard (WhatsApp > API Setup).
 */
@Injectable()
export class WhatsappApiService {
  private readonly logger = new Logger(WhatsappApiService.name);

  constructor(private readonly configService: ConfigService) {}

  private get token() {
    return this.configService.get<string>('WHATSAPP_TOKEN');
  }

  private get baseUrl() {
    const version = this.configService.get<string>('WHATSAPP_API_VERSION') || 'v23.0';
    return `https://graph.facebook.com/${version}`;
  }

  isEnabled(): boolean {
    return Boolean(
      this.token && this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID'),
    );
  }

  async sendText(to: string, body: string): Promise<void> {
    await this.send(to, {
      type: 'text',
      text: { body: body.slice(0, 4096), preview_url: true },
    });
  }

  /** Message with up to 3 quick-reply buttons. */
  async sendButtons(
    to: string,
    body: string,
    buttons: Array<{ id: string; title: string }>,
  ): Promise<void> {
    await this.send(to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body.slice(0, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    });
  }

  /** Uploads an image (e.g. a receipt PNG) and sends it with a caption. */
  async sendImage(to: string, png: Buffer, caption: string): Promise<void> {
    const phoneNumberId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'image/png');
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'receipt.png');
    const upload = await fetch(`${this.baseUrl}/${phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    const media: any = await upload.json().catch(() => ({}));
    if (!upload.ok || !media?.id) {
      throw new Error(`WhatsApp media upload failed (${upload.status})`);
    }
    await this.send(to, {
      type: 'image',
      image: { id: media.id, caption: caption.slice(0, 1024) },
    });
  }

  /**
   * Approved template message. Needed to message a trader who hasn't written
   * to the bot in the last 24 hours (WhatsApp's rule for business-started chats).
   */
  async sendTemplate(
    to: string,
    name: string,
    params: string[],
    language = 'en',
  ): Promise<void> {
    await this.send(to, {
      type: 'template',
      template: {
        name,
        language: { code: language },
        components: [
          {
            type: 'body',
            parameters: params.map((text) => ({ type: 'text', text })),
          },
        ],
      },
    });
  }

  /** Downloads an incoming voice note / audio file. */
  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimetype: string }> {
    const meta = await fetch(`${this.baseUrl}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(15000),
    });
    const info: any = await meta.json().catch(() => ({}));
    if (!meta.ok || !info?.url) {
      throw new Error(`WhatsApp media lookup failed (${meta.status})`);
    }

    const file = await fetch(info.url, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!file.ok) throw new Error(`WhatsApp media download failed (${file.status})`);
    return {
      buffer: Buffer.from(await file.arrayBuffer()),
      // Voice notes arrive as "audio/ogg; codecs=opus".
      mimetype: String(info.mime_type || 'audio/ogg').split(';')[0],
    };
  }

  private async send(to: string, message: Record<string, unknown>): Promise<void> {
    const phoneNumberId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const response = await fetch(`${this.baseUrl}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        ...message,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      this.logger.error(`[WhatsApp] send failed ${response.status}: ${detail}`);
      throw new Error(`WhatsApp send failed (${response.status})`);
    }
  }
}
