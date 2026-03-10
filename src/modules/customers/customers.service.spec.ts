import { Test, TestingModule } from '@nestjs/testing';
import { CustomersService } from './customers.service';
import { getModelToken } from '@nestjs/mongoose';
import { Customer } from './schemas/customer.schema';
import { NotFoundException } from '@nestjs/common';

describe('CustomersService', () => {
  let service: CustomersService;
  let model: any;

  const mockCustomer = {
    _id: 'cust-id-1',
    name: 'Babatunde Adekunle',
    phone: '+2348012345678',
    email: 'babatunde@example.com',
    address: '12 Bode Thomas, Lagos',
    outstandingBalance: 0,
    isDeleted: false,
  };

  const mockQuery = {
    exec: jest.fn(),
    find: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
  };

  const mockCustomerModel = {
    find: jest.fn().mockReturnThis(),
    findOne: jest.fn().mockReturnThis(),
    findOneAndUpdate: jest.fn().mockReturnThis(),
    findByIdAndUpdate: jest.fn().mockResolvedValue(undefined),
    exec: jest.fn(),
    save: jest.fn(),
  };

  // Mock constructor behavior
  function MockModel(dto: any) {
    return {
      ...dto,
      save: jest.fn().mockResolvedValue({ ...dto, _id: 'new-id' }),
    };
  }
  Object.assign(MockModel, mockCustomerModel);

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        {
          provide: getModelToken(Customer.name),
          useValue: MockModel,
        },
      ],
    }).compile();

    service = module.get<CustomersService>(CustomersService);
    model = module.get(getModelToken(Customer.name));
  });

  describe('findAll', () => {
    it('should filter out soft-deleted customers', async () => {
      const findSpy = jest.spyOn(model, 'find').mockReturnValue({
        exec: jest.fn().mockResolvedValue([mockCustomer]),
      } as any);

      const result = await service.findAll('owner-1');
      expect(findSpy).toHaveBeenCalledWith({
        shopOwner: 'owner-1',
        isDeleted: { $ne: true },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('findOne', () => {
    it('should return customer when found', async () => {
      jest.spyOn(model, 'findOne').mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockCustomer),
      } as any);

      const result = await service.findOne('cust-id-1', 'owner-1');
      expect(result).toEqual(mockCustomer);
    });

    it('should throw NotFoundException when customer not found', async () => {
      jest.spyOn(model, 'findOne').mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      } as any);

      await expect(service.findOne('non-existent', 'owner-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('should update and return updated customer', async () => {
      const updated = { ...mockCustomer, name: 'Updated Name' };
      jest.spyOn(model, 'findOneAndUpdate').mockReturnValue({
        exec: jest.fn().mockResolvedValue(updated),
      } as any);

      const result = await service.update(
        'cust-id-1',
        { name: 'Updated Name' },
        'owner-1',
      );
      expect(result.name).toBe('Updated Name');
    });

    it('should throw NotFoundException when updating non-existent customer', async () => {
      jest.spyOn(model, 'findOneAndUpdate').mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      } as any);

      await expect(
        service.update('non-existent', { name: 'X' }, 'owner-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('softDelete', () => {
    it('should soft-delete a customer and return success message', async () => {
      jest.spyOn(model, 'findOneAndUpdate').mockReturnValue({
        exec: jest
          .fn()
          .mockResolvedValue({
            ...mockCustomer,
            isDeleted: true,
            name: 'Babatunde Adekunle',
          }),
      } as any);

      const result = await service.softDelete('cust-id-1', 'owner-1', {
        reason: 'Test reason',
      });
      expect(result.message).toContain('deleted successfully');
      expect(result.customerId).toBe('cust-id-1');
    });

    it('should throw NotFoundException when soft-deleting non-existent customer', async () => {
      jest.spyOn(model, 'findOneAndUpdate').mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      } as any);

      await expect(
        service.softDelete('non-existent', 'owner-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateBalance', () => {
    it('should call findByIdAndUpdate with $inc', async () => {
      const spy = jest
        .spyOn(model, 'findByIdAndUpdate')
        .mockResolvedValue(undefined);

      await service.updateBalance('cust-id-1', 500);
      expect(spy).toHaveBeenCalledWith('cust-id-1', {
        $inc: { outstandingBalance: 500 },
        lastTransactionDate: expect.any(Date),
      });
    });

    it('should increment balance with negative for payments', async () => {
      const spy = jest
        .spyOn(model, 'findByIdAndUpdate')
        .mockResolvedValue(undefined);
      await service.updateBalance('cust-id-1', -300);
      expect(spy).toHaveBeenCalledWith('cust-id-1', {
        $inc: { outstandingBalance: -300 },
        lastTransactionDate: expect.any(Date),
      });
    });
  });
});
