import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Connection, ObjectId, Types } from 'mongoose';
import {
  Transaction,
  TransactionDocument,
  TransactionItem,
  TransactionType,
} from './schemas/transaction.schema';
import {
  CreateTransactionDto,
  CreateAdjustmentDto,
} from './dto/transaction.dto';
import { CustomersService } from '../customers/customers.service';
import { InjectConnection } from '@nestjs/mongoose';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import * as crypto from 'crypto';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectModel(Transaction.name)
    private transactionModel: Model<TransactionDocument>,
    private customersService: CustomersService,
    @InjectConnection() private readonly connection: Connection,
    private realtimeGateway: RealtimeGateway,
  ) {}

  async create(
    createTransactionDto: CreateTransactionDto,
    userId: string,
  ): Promise<TransactionDocument> {
    const { idempotencyKey, customerId, items, type, amount } = createTransactionDto;

    // Check idempotency
    const existing = await this.transactionModel.findOne({ idempotencyKey });
    if (existing) {
      return existing;
    }

    const session = await this.connection.startSession();
    session.startTransaction();

    try {
      let totalAmount = 0;
      let transactionItems: TransactionItem[] = [];

      if (items && items.length > 0) {
        totalAmount = items.reduce(
          (sum, item) => sum + item.unitPriceAtSale * item.quantity,
          0,
        );
        transactionItems = items.map((item) => ({
          ...item,
          productId: item.productId as string,
          totalPrice: item.unitPriceAtSale * item.quantity,
        }));
      } else if (amount !== undefined) {
        totalAmount = amount;
      }

      const transaction = new this.transactionModel({
        ...createTransactionDto,
        customer: customerId,
        shopOwner: userId,
        items: transactionItems,
        totalAmount,
      });

      // Generate hash for integrity
      transaction.hashSignature = this.generateHash(transaction);

      const savedTransaction = await transaction.save({ session });

      // Update customer balance
      const balanceChange =
        type === TransactionType.CREDIT ? totalAmount : -totalAmount;
      await this.customersService.updateBalance(customerId, balanceChange);

      await session.commitTransaction();

      // Real-time notification
      this.realtimeGateway.sendTransactionUpdate(userId, {
        type: 'transaction_created',
        transaction: savedTransaction,
      });

      return savedTransaction;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async syncOfflineTransactions(dtos: CreateTransactionDto[], userId: string) {
    const results = [];
    for (const dto of dtos) {
      try {
        const result = await this.create(dto, userId);
        results.push({
          idempotencyKey: dto.idempotencyKey,
          status: 'success',
          id: result._id,
        });
      } catch (error) {
        results.push({
          idempotencyKey: dto.idempotencyKey,
          status: 'error',
          message: error.message,
        });
      }
    }
    return results;
  }

  private generateHash(transaction: any): string {
    const dataToHash = {
      customerId: transaction.customer.toString(),
      total: transaction.totalAmount,
      type: transaction.type,
      idempotencyKey: transaction.idempotencyKey,
    };

    return crypto
      .createHash('sha256')
      .update(JSON.stringify(dataToHash))
      .digest('hex');
  }

  async createAdjustment(
    createAdjustmentDto: CreateAdjustmentDto,
    userId: string,
  ): Promise<TransactionDocument> {
    const { idempotencyKey, customerId, amount, reason } = createAdjustmentDto;

    const existing = await this.transactionModel.findOne({ idempotencyKey });
    if (existing) return existing;

    const session = await this.connection.startSession();
    session.startTransaction();

    try {
      const transaction = new this.transactionModel({
        customer: customerId,
        shopOwner: userId,
        totalAmount: amount,
        type: TransactionType.ADJUSTMENT,
        voiceTranscript: reason,
        idempotencyKey,
      });

      const savedTransaction = await transaction.save({ session });
      await this.customersService.updateBalance(customerId, amount);

      await session.commitTransaction();
      return savedTransaction;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async findByCustomer(
    customerId: string,
    userId: string,
  ): Promise<TransactionDocument[]> {
    return this.transactionModel
      .find({ customer: customerId as any, shopOwner: userId as any })
      .sort({ createdAt: -1 })
      .exec();
  }

  async getDailySummary(userId: string) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const summary = await this.transactionModel.aggregate([
      {
        $match: {
          shopOwner: userId as any,
          createdAt: { $gte: startOfDay },
        },
      },
      {
        $group: {
          _id: '$type',
          total: { $sum: '$totalAmount' },
          count: { $sum: 1 },
        },
      },
    ]);

    // Ensure we return data even if some types are missing
    const types = [TransactionType.CREDIT, TransactionType.PAYMENT];
    return types.map((type) => {
      const found = summary.find((s) => s._id === type);
      return (
        found || {
          _id: type,
          total: 0,
          count: 0,
        }
      );
    });
  }

  async findOne(id: string, userId: string): Promise<TransactionDocument> {
    const transaction = await this.transactionModel
      .findOne({ _id: id as any, shopOwner: userId as any })
      .exec();
    if (!transaction) {
      throw new NotFoundException(`Transaction with ID ${id} not found`);
    }
    return transaction;
  }
}
