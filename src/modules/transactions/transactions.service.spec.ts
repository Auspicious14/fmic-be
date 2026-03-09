import { Test, TestingModule } from '@nestjs/testing';
import { TransactionsService } from './transactions.service';
import { getModelToken, getConnectionToken } from '@nestjs/mongoose';
import { Transaction, TransactionType } from './schemas/transaction.schema';
import { CustomersService } from '../customers/customers.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let model: any;
  let customersService: any;
  let connection: any;
  let gateway: any;

  const mockTransactionModel = {
    findOne: jest.fn(),
    create: jest.fn(),
    aggregate: jest.fn(),
  };

  const mockCustomersService = {
    updateBalance: jest.fn(),
  };

  const mockConnection = {
    startSession: jest.fn().mockResolvedValue({
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      abortTransaction: jest.fn(),
      endSession: jest.fn(),
    }),
  };

  const mockRealtimeGateway = {
    sendTransactionUpdate: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
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

  it('should handle idempotency correctly', async () => {
    const dto: any = { idempotencyKey: 'test-key' };
    const existingTransaction = { _id: 'existing-id' };

    model.findOne.mockResolvedValue(existingTransaction);

    const result = await service.create(dto, 'user-id');

    expect(model.findOne).toHaveBeenCalledWith({ idempotencyKey: 'test-key' });
    expect(result).toEqual(existingTransaction);
    expect(connection.startSession).not.toHaveBeenCalled();
  });

  it('should generate a valid hash for integrity', async () => {
    const transaction = {
      customer: 'cust-id',
      totalAmount: 1000,
      type: TransactionType.CREDIT,
      idempotencyKey: 'idemp-1',
    };

    const hash = (service as any).generateHash(transaction);
    expect(hash).toBeDefined();
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64); // SHA-256 length
  });
});
