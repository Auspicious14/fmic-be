import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { Transaction, TransactionSchema } from './schemas/transaction.schema';
import { CustomersModule } from '../customers/customers.module';
import { ReceiptService } from './receipt.service';
import { AuthModule } from '../auth/auth.module';
import { SummaryJobService } from './summary-job.service';
import { ReceiptImageService } from './receipt-image.service';
import { LedgerQueryService } from './ledger-query.service';
import { Customer, CustomerSchema } from '../customers/schemas/customer.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
      { name: Customer.name, schema: CustomerSchema },
    ]),
    CustomersModule,
    AuthModule,
  ],
  providers: [
    TransactionsService,
    ReceiptService,
    SummaryJobService,
    ReceiptImageService,
    LedgerQueryService,
  ],
  controllers: [TransactionsController],
  exports: [
    TransactionsService,
    ReceiptService,
    ReceiptImageService,
    LedgerQueryService,
  ],
})
export class TransactionsModule {}
