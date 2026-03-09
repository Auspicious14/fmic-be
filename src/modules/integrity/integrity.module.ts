import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IntegrityService } from './integrity.service';
import { IntegrityController } from './integrity.controller';
import { AuditLog, AuditLogSchema } from './schemas/audit-log.schema';
import { TransactionsModule } from '../transactions/transactions.module';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuditLog.name, schema: AuditLogSchema },
    ]),
    TransactionsModule,
  ],
  providers: [IntegrityService],
  controllers: [IntegrityController],
  exports: [IntegrityService],
})
export class IntegrityModule {}
