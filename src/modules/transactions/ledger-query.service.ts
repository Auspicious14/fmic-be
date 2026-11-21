import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Transaction,
  TransactionDocument,
  TransactionType,
} from './schemas/transaction.schema';
import {
  Customer,
  CustomerDocument,
} from '../customers/schemas/customer.schema';
import { startOfLagosDay } from '../../common/utils/lagos-time';

export type LedgerPeriod = 'today' | 'yesterday' | 'week' | 'month' | 'all';

export interface PeriodRange {
  from?: Date;
  to?: Date;
  label: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A saved entry as the bot shows it. */
export interface LedgerEntry {
  type: TransactionType;
  totalAmount: number;
  items?: Array<{ productName: string; quantity: number }>;
  createdAt: Date;
  customer?: { name: string; tag?: string } | null;
}

/** Turns "today", "this week", … into a date range in Lagos time. */
export function periodRange(
  period: LedgerPeriod | undefined,
  now = new Date(),
): PeriodRange {
  const today = startOfLagosDay(now);
  switch (period) {
    case 'yesterday':
      return {
        from: new Date(today.getTime() - DAY_MS),
        to: today,
        label: 'yesterday',
      };
    case 'week':
      return {
        from: new Date(today.getTime() - 6 * DAY_MS),
        label: 'in the last 7 days',
      };
    case 'month':
      return {
        from: new Date(today.getTime() - 29 * DAY_MS),
        label: 'in the last 30 days',
      };
    case 'all':
      return { label: 'so far' };
    case 'today':
    default:
      return { from: today, label: 'today' };
  }
}

/**
 * Read-only answers for questions traders ask the bot:
 * "who owe me?", "how much Kamau owe?", "who pay today?".
 */
@Injectable()
export class LedgerQueryService {
  constructor(
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
  ) {}

  /** Customers who owe something, biggest first. */
  async debtors(userId: string) {
    const customers = await this.customerModel
      .find({
        shopOwner: userId as any,
        isDeleted: { $ne: true },
        outstandingBalance: { $gt: 0 },
      })
      .sort({ outstandingBalance: -1 })
      .select('name tag outstandingBalance lastTransactionDate')
      .lean()
      .exec();
    const total = customers.reduce(
      (sum, c) => sum + (c.outstandingBalance || 0),
      0,
    );
    return { customers, total };
  }

  /** Sales on credit or payments in a period, newest first. */
  async entries(userId: string, type: TransactionType, range: PeriodRange) {
    const createdAt: Record<string, Date> = {};
    if (range.from) createdAt.$gte = range.from;
    if (range.to) createdAt.$lt = range.to;
    const entries = await this.transactionModel
      .find({
        shopOwner: userId as any,
        type,
        ...(range.from || range.to ? { createdAt } : {}),
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('customer', 'name tag')
      .lean<LedgerEntry[]>()
      .exec();
    const total = entries.reduce((sum, e) => sum + (e.totalAmount || 0), 0);
    return { entries, total };
  }

  /** One customer's balance and their last few entries. */
  async customerHistory(userId: string, customerId: string, limit = 5) {
    if (!Types.ObjectId.isValid(customerId)) return null;
    const shopOwner = userId as any;
    const customer = await this.customerModel
      .findOne({ _id: customerId as any, shopOwner, isDeleted: { $ne: true } })
      .select('name tag outstandingBalance')
      .lean()
      .exec();
    if (!customer) return null;
    const recent = await this.transactionModel
      .find({ shopOwner, customer: customer._id as any })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('type totalAmount items createdAt')
      .lean<LedgerEntry[]>()
      .exec();
    return { customer, recent };
  }
}
