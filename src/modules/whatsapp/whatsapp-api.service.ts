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

  /**
   * Blue ticks plus the "typing…" bubble on the trader's message while we
   * work. WhatsApp clears it when we reply, or after 25 seconds.
   */
  async showTyping(messageId: string): Promise<void> {
    const phoneNumberId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const response = await fetch(`${this.baseUrl}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      throw new Error(`WhatsApp typing indicator failed (${response.status})`);
    }
  }

  /** Uploads an image (e.g. a receipt PNG) and sends it with a caption. */
  async sendImage(to: string, png: Buffer, caption: string): Promise<void> {
    const mediaId = await this.uploadMedia(png, 'image/png', 'receipt.png');
    await this.send(to, {
      type: 'image',
      image: { id: mediaId, caption: caption.slice(0, 1024) },
    });
  }

  /** Sends an OGG/Opus clip so it shows as a voice note, not a file. */
  async sendVoice(to: string, ogg: Buffer): Promise<void> {
    const mediaId = await this.uploadMedia(ogg, 'audio/ogg', 'ledga.ogg');
    try {
      await this.send(to, { type: 'audio', audio: { id: mediaId, voice: true } });
    } catch {
      // Older API versions don't know "voice"; it still plays as audio.
      await this.send(to, { type: 'audio', audio: { id: mediaId } });
    }
  }

  private async uploadMedia(data: Buffer, type: string, filename: string): Promise<string> {
    const phoneNumberId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', type);
    form.append('file', new Blob([new Uint8Array(data)], { type }), filename);
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
    return String(media.id);
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
    // The id lets a later "not delivered" status be matched to this reply.
    const sent: any = await response.json().catch(() => ({}));
    this.logger.log(`[WhatsApp] sent ${String(message.type)} ${sent?.messages?.[0]?.id ?? ''}`);
  }
}
