import { Injectable, Logger } from '@nestjs/common';
import { OnModuleInit } from '@nestjs/common';

@Injectable()
export class AppService {
  private logger = new Logger(AppService.name);

  async onModuleInit() {
    // Ping the Space on startup so it's warm when first user arrives
    this.warmupHFSpace();
  }

  private async warmupHFSpace() {
    const spaceUrl = process.env.HF_SPACE_URL;
    if (!spaceUrl) return;

    this.logger.log('[AppService] Warming up HuggingFace Space...');
    try {
      // Just hit the health endpoint — no audio needed
      const response = await fetch(`${spaceUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(90000), // 90s — enough for full cold start
      });
      this.logger.log(`[AppService] HF Space warmed up: ${response.status}`);
    } catch (error) {
      this.logger.warn(`[AppService] Space warmup failed: ${(error as Error).message}`);
    }
  }
}
