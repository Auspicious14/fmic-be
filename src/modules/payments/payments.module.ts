import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { TransactionsModule } from '../transactions/transactions.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { Customer, CustomerSchema } from '../customers/schemas/customer.schema';
import { User, UserSchema } from '../auth/schemas/user.schema';

@Module({
  imports: [
    TransactionsModule,
    WhatsappModule,
    MongooseModule.forFeature([
      { name: Customer.name, schema: CustomerSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  providers: [PaymentsService],
  controllers: [PaymentsController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
