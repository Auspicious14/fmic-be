import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { WhatsappService } from './whatsapp.service';

/**
 * Meta webhook. Set the callback URL to https://<api>/api/whatsapp/webhook and
 * the verify token to WHATSAPP_VERIFY_TOKEN in Meta's dashboard.
 */
@ApiExcludeController()
@Controller('whatsapp')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly configService: ConfigService,
  ) {}

  /** Meta calls this once when you save the webhook URL. */
  @Get('webhook')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const expected = this.configService.get<string>('WHATSAPP_VERIFY_TOKEN');
    if (mode === 'subscribe' && expected && token === expected) return challenge;
    throw new ForbiddenException('Verification failed');
  }

  @Post('webhook')
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string,
    @Body() payload: any,
  ) {
    this.assertSignature(req.rawBody, signature);
    // Processed before replying 200: serverless hosts stop work after the
    // response. Duplicate deliveries are ignored by message id.
    await this.whatsappService.handleWebhook(payload);
    return { ok: true };
  }

  /** Proves the request came from Meta (needs WHATSAPP_APP_SECRET). */
  private assertSignature(rawBody: Buffer | undefined, signature?: string) {
    const appSecret = this.configService.get<string>('WHATSAPP_APP_SECRET');
    if (!appSecret) {
      this.logger.warn('[WhatsApp] WHATSAPP_APP_SECRET not set: webhook signature not checked');
      return;
    }
    if (!rawBody || !signature?.startsWith('sha256=')) {
      throw new ForbiddenException('Missing signature');
    }
    const expected = Buffer.from(
      `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`,
    );
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new ForbiddenException('Invalid signature');
    }
  }
}
