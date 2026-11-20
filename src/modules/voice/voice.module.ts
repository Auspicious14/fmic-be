import { Module } from '@nestjs/common';
import { VoiceService } from './voice.service';
import { VoiceController } from './voice.controller';
import { CustomersModule } from '../customers/customers.module';
import { ProductsModule } from '../products/products.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { KokoroService } from './services/kokoro.service';
import { ThrottlerModule } from '@nestjs/throttler';
import { LanguageDetectionService } from './services/language-detection.service';
import { GroqService } from './services/groq.service';
import { AudioPreprocessorService } from './services/audio-preprocessor.service';
import { GeminiService } from './services/gemini.service';
import { SpitchService } from './services/spitch.service';
import { IntronService } from './services/intron.service';

@Module({
  imports: [
    CustomersModule,
    ProductsModule,
    TransactionsModule,
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 60,
      },
    ]),
  ],
  providers: [
    GroqService,
    VoiceService,
    KokoroService,
    LanguageDetectionService,
    AudioPreprocessorService,
    GeminiService,
    SpitchService,
    IntronService,
  ],
  controllers: [VoiceController],
  exports: [VoiceService],
})
export class VoiceModule {}
