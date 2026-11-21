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
import {
  LAGOS_TIME_ZONE,
  lagosDateString,
  startOfLagosDay,
} from '../../common/utils/lagos-time';

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

  /** True if an entry with this idempotency key was already saved. */
  async existsByIdempotencyKey(idempotencyKey: string): Promise<boolean> {
    return Boolean(await this.transactionModel.exists({ idempotencyKey }));
  }

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
        ({ totalAmount, transactionItems } = this.priceItems(items, amount));
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
      await this.customersService.updateBalance(
        customerId,
        balanceChange,
        session,
      );

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
      await this.customersService.updateBalance(customerId, amount, session);

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
    // "Today" means today in Lagos, not today on the (UTC) server.
    const startOfDay = startOfLagosDay();

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
      date: lagosDateString(),
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
    const sevenDaysAgo = startOfLagosDay(
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    );

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
            date: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$createdAt',
                timezone: LAGOS_TIME_ZONE,
              },
            },
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
      .populate('customer', 'name phone email address outstandingBalance')
      .exec();
    if (!transaction) {
      throw new NotFoundException(`Transaction with ID ${id} not found`);
    }
    return transaction;
  }

  /**
   * Receipt HTML for the public link sent to a customer (no login).
   * The caller must have verified the link signature first.
   */
  async getPublicReceiptHtml(id: string): Promise<string> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Receipt not found');
    }
    const transaction = await this.transactionModel
      .findById(id)
      .populate('customer', 'name phone outstandingBalance')
      .populate('shopOwner', 'shopName name')
      .exec();
    if (!transaction) throw new NotFoundException('Receipt not found');
    const data = this.receiptService.buildReceiptData(
      transaction,
      (transaction as any).customer,
      (transaction as any).shopOwner,
    );
    return this.receiptService.generateReceiptHtml(data);
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

  /**
   * Line totals and the transaction total.
   *
   * Traders often say only the total ("3 akara, it's 1000"), so items can
   * arrive without a unit price. Then the stated amount is the truth: the
   * part not covered by priced items is spread over the unpriced ones (the
   * last line absorbs rounding), so the lines still add up to the amount.
   */
  private priceItems(
    items: CreateTransactionDto['items'],
    amount?: number,
  ): { totalAmount: number; transactionItems: TransactionItem[] } {
    const list = items ?? [];
    const isPriced = (item: { unitPriceAtSale: number }) =>
      Number(item.unitPriceAtSale) > 0;
    const pricedTotal = list
      .filter(isPriced)
      .reduce((sum, item) => sum + item.unitPriceAtSale * item.quantity, 0);
    const unpriced = list.filter((item) => !isPriced(item));
    const stated = Number(amount) > 0 ? Number(amount) : 0;

    const useStated =
      stated > 0 &&
      (unpriced.length > 0 || Math.abs(pricedTotal - stated) < 1);
    const remaining = useStated ? Math.max(stated - pricedTotal, 0) : 0;
    const unpricedUnits = unpriced.reduce(
      (sum, item) => sum + (Number(item.quantity) || 1),
      0,
    );
    const lastUnpriced = unpriced[unpriced.length - 1];
    let allocated = 0;

    const transactionItems: TransactionItem[] = list.map((item) => {
      if (isPriced(item) || !unpricedUnits) {
        return {
          ...item,
          productId: item.productId as string,
          totalPrice: item.unitPriceAtSale * item.quantity,
        };
      }
      const quantity = Number(item.quantity) || 1;
      const totalPrice =
        item === lastUnpriced
          ? Math.round((remaining - allocated) * 100) / 100
          : Math.round(((remaining * quantity) / unpricedUnits) * 100) / 100;
      allocated += totalPrice;
      return {
        ...item,
        productId: item.productId as string,
        unitPriceAtSale: Math.round((totalPrice / quantity) * 100) / 100,
        totalPrice,
      };
    });

    // Prices derived from a total (e.g. 3 x 333.33) can miss it by a kobo;
    // make the last line take the difference so lines add up exactly.
    if (useStated && unpriced.length === 0 && transactionItems.length) {
      const linesTotal = transactionItems.reduce((sum, i) => sum + i.totalPrice, 0);
      const last = transactionItems[transactionItems.length - 1];
      last.totalPrice = Math.round((last.totalPrice + stated - linesTotal) * 100) / 100;
    }

    const totalAmount = useStated
      ? stated
      : transactionItems.reduce((sum, item) => sum + item.totalPrice, 0);
    return { totalAmount, transactionItems };
  }
}
