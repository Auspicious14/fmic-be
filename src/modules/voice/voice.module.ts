import { Module } from '@nestjs/common';
import { VoiceService } from './voice.service';
import { VoiceController } from './voice.controller';
import { CustomersModule } from '../customers/customers.module';
import { ProductsModule } from '../products/products.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { KokoroService } from './services/kokoro.service';
import { ThrottlerModule } from '@nestjs/throttler';
import { LanguageDetectionService } from './services/language-detection.service';

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
  providers: [VoiceService, KokoroService, LanguageDetectionService],
  controllers: [VoiceController],
  exports: [VoiceService, KokoroService],
})
export class VoiceModule {}
