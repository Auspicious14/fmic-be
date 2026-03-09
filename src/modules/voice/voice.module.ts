
import { Module } from '@nestjs/common';
import { VoiceService } from './voice.service';
import { VoiceController } from './voice.controller';
import { CustomersModule } from '../customers/customers.module';
import { ProductsModule } from '../products/products.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { GroqService } from './services/groq.service';
import { KokoroService } from './services/kokoro.service';
import { ThrottlerModule } from '@nestjs/throttler';

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
  providers: [VoiceService, GroqService, KokoroService],
  controllers: [VoiceController],
  exports: [VoiceService, GroqService, KokoroService],
})
export class VoiceModule {}
