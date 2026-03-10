import { Test, TestingModule } from '@nestjs/testing';
import { TransactionsService } from './transactions.service';
import { getModelToken, getConnectionToken } from '@nestjs/mongoose';
import { Transaction, TransactionType } from './schemas/transaction.schema';
import { CustomersService } from '../customers/customers.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ReceiptService } from './receipt.service';
import { Types } from 'mongoose';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let model: any;
  let customersService: any;
  let connection: any;
  let gateway: any;

  const mockSession = {
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    abortTransaction: jest.fn(),
    endSession: jest.fn(),
  };

  const mockTx = {
    _id: new Types.ObjectId(),
    customer: new Types.ObjectId(),
    shopOwner: new Types.ObjectId(),
    totalAmount: 500,
    type: TransactionType.CREDIT,
    idempotencyKey: 'key-1',
    hashSignature: null,
    items: [],
    save: jest.fn().mockResolvedValue(this),
  };

  const mockTransactionModel = {
    findOne: jest.fn(),
    find: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
    aggregate: jest.fn().mockResolvedValue([]),
    countDocuments: jest.fn().mockResolvedValue(0),
  };

  const mockCustomersService = {
    updateBalance: jest.fn().mockResolvedValue(undefined),
  };

  const mockConnection = {
    startSession: jest.fn().mockResolvedValue(mockSession),
  };

  const mockRealtimeGateway = {
    sendTransactionUpdate: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        ReceiptService,
        {
          provide: getModelToken(Transaction.name),
          useValue: mockTransactionModel,
        },
        {
          provide: CustomersService,
          useValue: mockCustomersService,
        },
        {
          provide: getConnectionToken(),
          useValue: mockConnection,
        },
        {
          provide: RealtimeGateway,
          useValue: mockRealtimeGateway,
        },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
    model = module.get(getModelToken(Transaction.name));
    customersService = module.get(CustomersService);
    connection = module.get(getConnectionToken());
    gateway = module.get(RealtimeGateway);
  });

  describe('Idempotency', () => {
    it('should return existing transaction on duplicate idempotency key', async () => {
      const existingTx = { _id: 'existing-id' };
      model.findOne.mockResolvedValue(existingTx);

      const result = await service.create(
        { idempotencyKey: 'test-key' } as any,
        'user-id',
      );

      expect(model.findOne).toHaveBeenCalledWith({
        idempotencyKey: 'test-key',
      });
      expect(result).toEqual(existingTx);
      expect(connection.startSession).not.toHaveBeenCalled();
    });
  });

  describe('Hash Generation', () => {
    it('should generate a valid SHA-256 hash', () => {
      const transaction = {
        customer: 'cust-id',
        totalAmount: 1000,
        type: TransactionType.CREDIT,
        idempotencyKey: 'idemp-1',
      };

      const hash = (service as any).generateHash(transaction);
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64);
    });

    it('should generate different hashes for different transactions', () => {
      const tx1 = {
        customer: 'cust-1',
        totalAmount: 100,
        type: 'credit',
        idempotencyKey: 'k1',
      };
      const tx2 = {
        customer: 'cust-2',
        totalAmount: 200,
        type: 'payment',
        idempotencyKey: 'k2',
      };

      const hash1 = (service as any).generateHash(tx1);
      const hash2 = (service as any).generateHash(tx2);
      expect(hash1).not.toEqual(hash2);
    });

    it('should be deterministic — same input yields same hash', () => {
      const tx = {
        customer: 'cust-1',
        totalAmount: 100,
        type: 'credit',
        idempotencyKey: 'k1',
      };
      const h1 = (service as any).generateHash(tx);
      const h2 = (service as any).generateHash(tx);
      expect(h1).toEqual(h2);
    });
  });

  describe('getDailySummary', () => {
    it('should return structured daily summary', async () => {
      const mockAggregate = [
        { _id: 'credit', total: 5000, count: 3 },
        { _id: 'payment', total: 2000, count: 2 },
      ];
      model.aggregate
        .mockResolvedValueOnce(mockAggregate)
        .mockResolvedValueOnce([{ total: 4 }]);
      model.countDocuments.mockResolvedValue(5);

      const result = await service.getDailySummary('507f1f77bcf86cd799439011');

      expect(result).toHaveProperty('date');
      expect(result).toHaveProperty('totalTransactions');
      expect(result).toHaveProperty('totalRevenue');
      expect(result).toHaveProperty('totalCredit');
      expect(result).toHaveProperty('uniqueCustomers');
      expect(result).toHaveProperty('breakdown');
      expect(result.breakdown).toHaveLength(3); // credit, payment, adjustment
    });

    it('should return 0 values when no transactions today', async () => {
      model.aggregate.mockResolvedValue([]);
      model.countDocuments.mockResolvedValue(0);

      const result = await service.getDailySummary('507f1f77bcf86cd799439011');
      expect(result.totalRevenue).toBe(0);
      expect(result.totalCredit).toBe(0);
    });
  });

  describe('findAll', () => {
    it('should call findAll with default limit and skip', async () => {
      model.exec.mockResolvedValue([]);
      await service.findAll('user-id');
      expect(model.find).toHaveBeenCalledWith({
        shopOwner: 'user-id',
      });
    });
  });

  describe('verifyAllTransactions', () => {
    it('should return verification report with flagged transactions', async () => {
      const txWithBadHash = {
        _id: new Types.ObjectId(),
        customer: new Types.ObjectId(),
        totalAmount: 100,
        type: 'credit',
        idempotencyKey: 'key-1',
        hashSignature: 'invalid-hash-xyz',
        items: [],
        createdAt: new Date(),
      };

      // Use exec mock for find chain
      mockTransactionModel.exec.mockResolvedValueOnce([txWithBadHash]);

      const result = await service.verifyAllTransactions(
        '507f1f77bcf86cd799439011',
      );
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('flagged');
      expect(result).toHaveProperty('verifiedAt');
    });
  });

  describe('syncOfflineTransactions', () => {
    it('should process multiple DTOs and return results', async () => {
      const dtos = [
        {
          idempotencyKey: 'k1',
          customerId: 'c1',
          type: TransactionType.CREDIT,
          items: [],
        },
        {
          idempotencyKey: 'k2',
          customerId: 'c2',
          type: TransactionType.PAYMENT,
          amount: 500,
        },
      ] as any[];

      // Mock findOne to return existing (idempotent)
      model.findOne.mockResolvedValueOnce({ _id: 'existing-1' });
      model.findOne.mockResolvedValueOnce({ _id: 'existing-2' });

      const results = await service.syncOfflineTransactions(dtos, 'user-id');
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('success');
      expect(results[1].status).toBe('success');
    });

    it('should handle errors gracefully in sync', async () => {
      model.findOne.mockRejectedValueOnce(new Error('DB Error'));

      const dtos = [
        {
          idempotencyKey: 'k1',
          customerId: 'c1',
          type: TransactionType.CREDIT,
        },
      ] as any[];

      const results = await service.syncOfflineTransactions(dtos, 'user-id');
      expect(results[0].status).toBe('error');
      expect(results[0].message).toBe('DB Error');
    });
  });
});
