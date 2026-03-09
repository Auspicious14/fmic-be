import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';
import { TransactionsService } from '../transactions/transactions.service';

@Injectable()
export class IntegrityService {
  private readonly logger = new Logger(IntegrityService.name);

  constructor(
    @InjectModel(AuditLog.name) private auditLogModel: Model<AuditLogDocument>,
    private transactionsService: TransactionsService,
  ) {}

  async createAuditLog(
    action: string,
    performedBy: string,
    transactionId?: string,
    details?: any,
    ipAddress?: string,
  ): Promise<AuditLogDocument> {
    const log = new this.auditLogModel({
      action,
      performedBy,
      transactionId,
      details,
      ipAddress,
    });
    return log.save();
  }

  async verifyTransactionIntegrity(transactionId: string, userId: string) {
    const transaction = await this.transactionsService.findOne(
      transactionId,
      userId,
    );

    // In a real scenario, we'd compare the stored hash with a freshly computed hash
    // of all immutable fields.
    const calculatedHash = this.generateTransactionHash(transaction);

    const isTampered =
      transaction.hashSignature && transaction.hashSignature !== calculatedHash;

    return {
      transactionId,
      isValid: !isTampered,
      storedHash: transaction.hashSignature,
      calculatedHash,
      timestamp: new Date(),
    };
  }

  private generateTransactionHash(transaction: any): string {
    const dataToHash = {
      id: transaction._id.toString(),
      customerId: transaction.customer.toString(),
      items: transaction.items.map((i: any) => ({
        name: i.productName,
        qty: i.quantity,
        price: i.unitPriceAtSale,
      })),
      total: transaction.totalAmount,
      type: transaction.type,
      createdAt: transaction.createdAt,
    };

    return crypto
      .createHash('sha256')
      .update(JSON.stringify(dataToHash))
      .digest('hex');
  }

  async getAuditLogForTransaction(
    transactionId: string,
    userId: string,
  ): Promise<AuditLogDocument[]> {
    // Basic verification that user owns transaction
    await this.transactionsService.findOne(transactionId, userId);

    return this.auditLogModel
      .find({ transactionId: transactionId as any })
      .sort({ createdAt: -1 })
      .exec();
  }

  async getTransactionEvidence(transactionId: string, userId: string) {
    const transaction = await this.transactionsService.findOne(
      transactionId,
      userId,
    );
    const auditLogs = await this.getAuditLogForTransaction(
      transactionId,
      userId,
    );

    return {
      transaction,
      auditLogs,
      verification: await this.verifyTransactionIntegrity(
        transactionId,
        userId,
      ),
    };
  }
}
