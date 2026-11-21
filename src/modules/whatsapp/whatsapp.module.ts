import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappApiService } from './whatsapp-api.service';
import { VoiceModule } from '../voice/voice.module';
import { CustomersModule } from '../customers/customers.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { User, UserSchema } from '../auth/schemas/user.schema';
import {
  WhatsappPending,
  WhatsappPendingSchema,
  WhatsappSeen,
  WhatsappSeenSchema,
} from './schemas/whatsapp.schema';

@Module({
  imports: [
    VoiceModule,
    CustomersModule,
    TransactionsModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: WhatsappPending.name, schema: WhatsappPendingSchema },
      { name: WhatsappSeen.name, schema: WhatsappSeenSchema },
    ]),
  ],
  controllers: [WhatsappController],
  providers: [WhatsappService, WhatsappApiService],
  exports: [WhatsappApiService],
})
export class WhatsappModule {}
