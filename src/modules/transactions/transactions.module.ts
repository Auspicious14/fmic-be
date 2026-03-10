import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { Transaction, TransactionSchema } from './schemas/transaction.schema';
import { CustomersModule } from '../customers/customers.module';
import { ReceiptService } from './receipt.service';
import { AuthModule } from '../auth/auth.module';
import { SummaryJobService } from './summary-job.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
    ]),
    CustomersModule,
    AuthModule,
  ],
  providers: [TransactionsService, ReceiptService, SummaryJobService],
  controllers: [TransactionsController],
  exports: [TransactionsService, ReceiptService],
})
export class TransactionsModule {}
