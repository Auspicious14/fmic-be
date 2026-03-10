import { Test, TestingModule } from '@nestjs/testing';
import { ReceiptService } from './receipt.service';

describe('ReceiptService', () => {
  let service: ReceiptService;

  const mockTransaction = {
    _id: { toString: () => '507f1f77bcf86cd799439011' },
    customer: {
      _id: 'cust-1',
      name: 'Babatunde Adekunle',
      phone: '+2348012345678',
    },
    items: [
      {
        productName: 'Indomie',
        quantity: 3,
        unitPriceAtSale: 150,
        totalPrice: 450,
      },
      {
        productName: 'Milo Tin',
        quantity: 1,
        unitPriceAtSale: 2500,
        totalPrice: 2500,
      },
    ],
    totalAmount: 2950,
    type: 'credit',
    voiceTranscript: 'Customer bought on credit',
    createdAt: new Date('2026-03-10T13:00:00Z'),
    hashSignature: 'abc123',
    idempotencyKey: 'key-1',
  };

  const mockCustomer = {
    _id: 'cust-1',
    name: 'Babatunde Adekunle',
    phone: '+2348012345678',
    email: 'babatunde@example.com',
  };

  const mockShopOwner = {
    userId: 'owner-1',
    name: "Emeka's Store",
    shopName: 'Emeka General Stores',
    email: 'emeka@store.com',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReceiptService],
    }).compile();

    service = module.get<ReceiptService>(ReceiptService);
  });

  describe('generateReceiptNumber', () => {
    it('should generate a receipt number with correct format', () => {
      const receiptNo = service.generateReceiptNumber(
        '507f1f77bcf86cd799439011',
      );
      expect(receiptNo).toMatch(/^RCP-\d{8}-[A-F0-9]{8}$/);
    });

    it('should generate different receipt numbers for different transaction IDs', () => {
      const receipt1 = service.generateReceiptNumber(
        '507f1f77bcf86cd799439011',
      );
      const receipt2 = service.generateReceiptNumber(
        '507f1f77bcf86cd799439012',
      );
      expect(receipt1).not.toEqual(receipt2);
    });

    it('should generate consistent receipt number for same transaction ID', () => {
      const r1 = service.generateReceiptNumber('507f1f77bcf86cd799439011');
      const r2 = service.generateReceiptNumber('507f1f77bcf86cd799439011');
      expect(r1).toEqual(r2);
    });
  });

  describe('buildReceiptData', () => {
    it('should build correct receipt data from transaction', () => {
      const data = service.buildReceiptData(
        mockTransaction,
        mockCustomer,
        mockShopOwner,
      );

      expect(data.customerName).toBe('Babatunde Adekunle');
      expect(data.businessName).toBe('Emeka General Stores');
      expect(data.totalAmount).toBe(2950);
      expect(data.subtotal).toBe(2950);
      expect(data.items).toHaveLength(2);
      expect(data.transactionType).toBe('credit');
    });

    it('should calculate items correctly', () => {
      const data = service.buildReceiptData(
        mockTransaction,
        mockCustomer,
        mockShopOwner,
      );
      expect(data.items[0].productName).toBe('Indomie');
      expect(data.items[0].quantity).toBe(3);
      expect(data.items[0].unitPrice).toBe(150);
      expect(data.items[0].totalPrice).toBe(450);
    });

    it('should handle missing customer gracefully', () => {
      const data = service.buildReceiptData(
        mockTransaction,
        null,
        mockShopOwner,
      );
      expect(data.customerName).toBe('Walk-in Customer');
      expect(data.customerPhone).toBe('');
    });

    it('should include receipt number', () => {
      const data = service.buildReceiptData(
        mockTransaction,
        mockCustomer,
        mockShopOwner,
      );
      expect(data.receiptNumber).toBeDefined();
      expect(data.receiptNumber).toMatch(/^RCP-/);
    });

    it('should set tax to 0 by default', () => {
      const data = service.buildReceiptData(
        mockTransaction,
        mockCustomer,
        mockShopOwner,
      );
      expect(data.tax).toBe(0);
    });
  });

  describe('generateReceiptHtml', () => {
    it('should generate valid HTML', () => {
      const data = service.buildReceiptData(
        mockTransaction,
        mockCustomer,
        mockShopOwner,
      );
      const html = service.generateReceiptHtml(data);
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Babatunde Adekunle');
      expect(html).toContain('Emeka General Stores');
    });

    it('should include receipt number in HTML', () => {
      const data = service.buildReceiptData(
        mockTransaction,
        mockCustomer,
        mockShopOwner,
      );
      const html = service.generateReceiptHtml(data);
      expect(html).toContain(data.receiptNumber);
    });

    it('should show CREDIT banner for credit transactions', () => {
      const data = service.buildReceiptData(
        mockTransaction,
        mockCustomer,
        mockShopOwner,
      );
      const html = service.generateReceiptHtml(data);
      expect(html).toContain('CREDIT (OWED)');
    });

    it('should show PAYMENT banner for payment transactions', () => {
      const paymentTx = { ...mockTransaction, type: 'payment' };
      const data = service.buildReceiptData(
        paymentTx,
        mockCustomer,
        mockShopOwner,
      );
      const html = service.generateReceiptHtml(data);
      expect(html).toContain('PAYMENT RECEIVED');
    });

    it('should include all items in HTML', () => {
      const data = service.buildReceiptData(
        mockTransaction,
        mockCustomer,
        mockShopOwner,
      );
      const html = service.generateReceiptHtml(data);
      expect(html).toContain('Indomie');
      expect(html).toContain('Milo Tin');
    });

    it('should format currency correctly', () => {
      const data = service.buildReceiptData(
        mockTransaction,
        mockCustomer,
        mockShopOwner,
      );
      const html = service.generateReceiptHtml(data);
      expect(html).toContain('₦2,950.00');
    });
  });

  describe('generateWhatsAppMessage', () => {
    it('should generate a WhatsApp formatted message', () => {
      const data = service.buildReceiptData(
        mockTransaction,
        mockCustomer,
        mockShopOwner,
      );
      const msg = service.generateWhatsAppMessage(data);
      expect(msg).toContain('TRANSACTION RECEIPT');
      expect(msg).toContain('Babatunde Adekunle');
      expect(msg).toContain('Emeka General Stores');
    });

    it('should include items in the message', () => {
      const data = service.buildReceiptData(
        mockTransaction,
        mockCustomer,
        mockShopOwner,
      );
      const msg = service.generateWhatsAppMessage(data);
      expect(msg).toContain('Indomie');
      expect(msg).toContain('Milo Tin');
    });

    it('should include total amount', () => {
      const data = service.buildReceiptData(
        mockTransaction,
        mockCustomer,
        mockShopOwner,
      );
      const msg = service.generateWhatsAppMessage(data);
      expect(msg).toContain('₦2,950.00');
    });
  });

  describe('buildWhatsAppUrl', () => {
    it('should build correct wa.me URL', () => {
      const url = service.buildWhatsAppUrl('+2348012345678', 'Hello there!');
      expect(url).toContain('wa.me/2348012345678');
      expect(url).toContain('Hello');
    });

    it('should normalize Nigerian phone number starting with 0', () => {
      const url = service.buildWhatsAppUrl('08012345678', 'Test message');
      expect(url).toContain('wa.me/2348012345678');
    });

    it('should handle phone numbers with spaces', () => {
      const url = service.buildWhatsAppUrl('+234 801 234 5678', 'Test');
      expect(url).toContain('wa.me/2348012345678');
    });
  });
});
