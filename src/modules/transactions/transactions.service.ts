import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Connection, Types, ObjectId } from 'mongoose';
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
import { ReceiptService } from './receipt.service';
import * as crypto from 'crypto';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectModel(Transaction.name)
    private transactionModel: Model<TransactionDocument>,
    private customersService: CustomersService,
    @InjectConnection() private readonly connection: Connection,
    private realtimeGateway: RealtimeGateway,
    private receiptService: ReceiptService,
  ) {}

  async create(
    createTransactionDto: CreateTransactionDto,
    userId: string,
  ): Promise<TransactionDocument> {
    const { idempotencyKey, customerId, items, type, amount } =
      createTransactionDto;

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
      .find({ customer: customerId as any, shopOwner: userId as any } as any)
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Get ALL transactions for the shop owner with customer name populated
   */
  async findAll(userId: string, limit = 50, skip = 0): Promise<any[]> {
    return this.transactionModel
      .find({ shopOwner: userId as any } as any)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('customer', 'name phone')
      .exec();
  }

  /**
   * Fixed daily summary — properly casts shopOwner to ObjectId and returns enriched data
   */
  async getDailySummary(userId: string) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const shopOwnerObjectId = new Types.ObjectId(userId);

    // Aggregate by transaction type
    const typeSummary = await this.transactionModel.aggregate([
      {
        $match: {
          shopOwner: shopOwnerObjectId,
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

    // Unique customers today
    const uniqueCustomers = await this.transactionModel.aggregate([
      {
        $match: {
          shopOwner: shopOwnerObjectId,
          createdAt: { $gte: startOfDay },
        },
      },
      {
        $group: {
          _id: '$customer',
        },
      },
      { $count: 'total' },
    ]);

    // Total transactions today
    const totalTransactions = await this.transactionModel.countDocuments({
      shopOwner: shopOwnerObjectId as any,
      createdAt: { $gte: startOfDay } as any,
    } as any);

    const types = [
      TransactionType.CREDIT,
      TransactionType.PAYMENT,
      TransactionType.ADJUSTMENT,
    ];
    const breakdown = types.map((type) => {
      const found = typeSummary.find((s) => s._id === type);
      return (
        found || {
          _id: type,
          total: 0,
          count: 0,
        }
      );
    });

    const totalRevenue = breakdown
      .filter((b) => b._id === TransactionType.PAYMENT)
      .reduce((sum, b) => sum + b.total, 0);

    const totalCredit = breakdown
      .filter((b) => b._id === TransactionType.CREDIT)
      .reduce((sum, b) => sum + b.total, 0);

    const totalRevenueCount =
      breakdown.find((b) => b._id === TransactionType.PAYMENT)?.count || 0;
    const totalCreditCount =
      breakdown.find((b) => b._id === TransactionType.CREDIT)?.count || 0;

    return {
      date: new Date().toISOString().split('T')[0],
      totalTransactions,
      totalRevenue,
      totalCredit,
      totalRevenueCount,
      totalCreditCount,
      uniqueCustomers: uniqueCustomers[0]?.total || 0,
      breakdown,
    };
  }

  /**
   * Get transaction trends for the last 7 days
   */
  async getWeeklyTrends(userId: string) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const shopOwnerObjectId = new Types.ObjectId(userId);

    const trends = await this.transactionModel.aggregate([
      {
        $match: {
          shopOwner: shopOwnerObjectId,
          createdAt: { $gte: sevenDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            type: '$type',
          },
          total: { $sum: '$totalAmount' },
          count: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: '$_id.date',
          data: {
            $push: {
              type: '$_id.type',
              total: '$total',
              count: '$count',
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return trends.map((t) => ({
      date: t._id,
      credit:
        t.data.find((d: any) => d.type === TransactionType.CREDIT)?.total || 0,
      payment:
        t.data.find((d: any) => d.type === TransactionType.PAYMENT)?.total || 0,
      txCount: t.data.reduce((sum: number, d: any) => sum + d.count, 0),
    }));
  }

  async findOne(id: string, userId: string): Promise<TransactionDocument> {
    const transaction = await this.transactionModel
      .findOne({ _id: id as any, shopOwner: userId as any })
      .populate('customer', 'name phone email address')
      .exec();
    if (!transaction) {
      throw new NotFoundException(`Transaction with ID ${id} not found`);
    }
    return transaction;
  }

  /**
   * Generate receipt data for a specific transaction
   */
  async getReceiptData(transactionId: string, userId: string, shopOwner: any) {
    const transaction = await this.findOne(transactionId, userId);
    const customer = (transaction as any).customer;

    const receiptData = this.receiptService.buildReceiptData(
      transaction,
      customer,
      shopOwner,
    );

    return {
      receipt: receiptData,
      html: this.receiptService.generateReceiptHtml(receiptData),
    };
  }

  /**
   * Generate WhatsApp sharing link for a receipt
   */
  async getWhatsAppReceiptLink(
    transactionId: string,
    userId: string,
    shopOwner: any,
    customerPhone?: string,
  ) {
    const transaction = await this.findOne(transactionId, userId);
    const customer = (transaction as any).customer;

    const receiptData = this.receiptService.buildReceiptData(
      transaction,
      customer,
      shopOwner,
    );

    const message = this.receiptService.generateWhatsAppMessage(receiptData);
    const phone = customerPhone || customer?.phone || '';

    let whatsappUrl: string | null = null;
    if (phone) {
      whatsappUrl = this.receiptService.buildWhatsAppUrl(phone, message);
    }

    return {
      message,
      whatsappUrl,
      receipt: receiptData,
    };
  }

  /**
   * Verify data integrity — compare all transaction hashes
   */
  async verifyAllTransactions(userId: string) {
    const shopOwnerObjectId = new Types.ObjectId(userId);
    const transactions = await this.transactionModel
      .find({ shopOwner: shopOwnerObjectId } as any)
      .exec();

    const results = transactions.map((tx) => {
      const calculated = this.generateHash(tx);
      const isValid = !tx.hashSignature || tx.hashSignature === calculated;
      return {
        transactionId: tx._id.toString(),
        isValid,
        createdAt: (tx as any).createdAt,
        amount: tx.totalAmount,
        type: tx.type,
      };
    });

    const flagged = results.filter((r) => !r.isValid);

    return {
      total: results.length,
      valid: results.filter((r) => r.isValid).length,
      flagged: flagged.length,
      flaggedTransactions: flagged,
      verifiedAt: new Date().toISOString(),
    };
  }
}
