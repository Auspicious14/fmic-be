import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { signLink } from '../../common/utils/signed-link';
import { TransactionType } from '../transactions/schemas/transaction.schema';

describe('PaymentsService', () => {
  const customerId = '507f1f77bcf86cd799439011';
  const ownerId = '507f1f77bcf86cd799439022';
  const fetchMock = jest.fn();
  const transactionsService = {
    create: jest.fn(async () => ({ _id: 'tx-1', type: 'payment', totalAmount: 15000 })),
    existsByIdempotencyKey: jest.fn(async () => false),
  };
  const whatsappApi = {
    isEnabled: jest.fn(() => true),
    sendText: jest.fn(),
    sendImage: jest.fn(),
    sendTemplate: jest.fn(),
  };
  const receiptService = {
    buildReceiptData: jest.fn(() => ({ businessName: 'Mama Shop' })),
  };
  const receiptImageService = { render: jest.fn(async () => Buffer.from('png')) };
  let templateName: string | undefined;
  let customer: any;

  const config = {
    get: (key: string) =>
      ({
        FLW_SECRET_KEY: 'FLWSECK_TEST',
        FLW_SECRET_HASH: 'my-hash',
        FLW_FALLBACK_EMAIL: 'pay@ledga.ng',
        WHATSAPP_PAYMENT_TEMPLATE: templateName,
      })[key],
  } as unknown as ConfigService;

  const customerModel = {
    findById: jest.fn(() => ({ exec: async () => customer })),
  };
  const userModel = {
    findById: jest.fn(() => ({
      select: () => ({
        exec: async () => ({ shopName: 'Mama Shop', email: 'o@x.ng', whatsappPhone: '2348031234567' }),
      }),
    })),
  };

  const service = () =>
    new PaymentsService(
      config,
      transactionsService as any,
      customerModel as any,
      userModel as any,
      whatsappApi as any,
      receiptService as any,
      receiptImageService as any,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    templateName = undefined;
    process.env.BACKEND_API_URL = 'https://api.example.com';
    global.fetch = fetchMock as unknown as typeof fetch;
    customer = {
      _id: customerId,
      name: 'Kamau',
      phone: '08030000000',
      outstandingBalance: 40000,
      shopOwner: { toString: () => ownerId },
      isDeleted: false,
    };
  });

  describe('createCheckoutForCustomer', () => {
    it('rejects a link with a wrong signature', async () => {
      await expect(
        service().createCheckoutForCustomer(customerId, 'forged'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('charges the current balance in NGN and returns the checkout link', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', data: { link: 'https://checkout/x' } })),
      );

      const result = await service().createCheckoutForCustomer(
        customerId,
        signLink('pay', customerId),
      );

      expect(result.link).toBe('https://checkout/x');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toMatchObject({
        amount: 40000,
        currency: 'NGN',
        redirect_url: 'https://api.example.com/api/pay/done',
        customer: { email: 'pay@ledga.ng', name: 'Kamau' },
      });
      expect(body.tx_ref).toMatch(new RegExp(`^ledga-${customerId}-\\d+$`));
    });

    it('returns no link when nothing is owed', async () => {
      customer.outstandingBalance = 0;
      const result = await service().createCheckoutForCustomer(
        customerId,
        signLink('pay', customerId),
      );
      expect(result.link).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('handleWebhook', () => {
    const payload = {
      event: 'charge.completed',
      data: { id: 999, status: 'successful', tx_ref: `ledga-${customerId}-1` },
    };

    const verifiedOk = () =>
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'success',
            data: {
              id: 999,
              status: 'successful',
              currency: 'NGN',
              amount: 15000,
              tx_ref: `ledga-${customerId}-1`,
              flw_ref: 'FLW-REF',
            },
          }),
        ),
      );

    it('ignores (with 200) a webhook without the secret hash', async () => {
      const result = await service().handleWebhook('wrong', payload);
      expect(result).toEqual({ recorded: false, reason: 'invalid signature' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it('re-verifies with Flutterwave and records a payment once', async () => {
      verifiedOk();

      const result = await service().handleWebhook('my-hash', payload);

      expect(result.recorded).toBe(true);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.flutterwave.com/v3/transactions/999/verify',
      );
      expect(transactionsService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId,
          type: TransactionType.PAYMENT,
          amount: 15000,
          idempotencyKey: 'flw-999',
        }),
        ownerId,
      );
    });

    it('tells the shop owner on WhatsApp who paid, with a receipt picture', async () => {
      verifiedOk();
      customer.outstandingBalance = 25000; // balance after the payment

      await service().handleWebhook('my-hash', payload);

      expect(whatsappApi.sendText).toHaveBeenCalledWith(
        '2348031234567',
        '💰 Kamau just paid you ₦15,000 online.\nKamau still owes ₦25,000.',
      );
      expect(whatsappApi.sendImage).toHaveBeenCalledWith(
        '2348031234567',
        Buffer.from('png'),
        'Receipt from Mama Shop: payment of ₦15,000 received. Thank you!',
      );
    });

    it('uses the approved template when the 24-hour window has closed', async () => {
      verifiedOk();
      templateName = 'payment_received';
      customer.outstandingBalance = 0;
      whatsappApi.sendText.mockRejectedValueOnce(new Error('WhatsApp send failed (400)'));

      const result = await service().handleWebhook('my-hash', payload);

      expect(result.recorded).toBe(true);
      expect(whatsappApi.sendTemplate).toHaveBeenCalledWith('2348031234567', 'payment_received', [
        'Kamau',
        '₦15,000',
        '₦0',
      ]);
    });

    it('still records the payment if the WhatsApp notice fails', async () => {
      verifiedOk();
      whatsappApi.sendText.mockRejectedValueOnce(new Error('WhatsApp send failed (400)'));
      const result = await service().handleWebhook('my-hash', payload);
      expect(result.recorded).toBe(true);
      expect(transactionsService.create).toHaveBeenCalledTimes(1);
    });

    it('records from the checkout redirect too, but only once in total', async () => {
      verifiedOk();
      const first = await service().recordFromRedirect('999');
      expect(first.recorded).toBe(true);

      verifiedOk();
      transactionsService.existsByIdempotencyKey.mockResolvedValueOnce(true);
      const second = await service().handleWebhook('my-hash', payload);

      expect(second).toEqual({ recorded: true, reason: 'already recorded' });
      expect(transactionsService.create).toHaveBeenCalledTimes(1);
      expect(whatsappApi.sendText).toHaveBeenCalledTimes(1);
    });

    it('ignores a redirect without a valid transaction id', async () => {
      const result = await service().recordFromRedirect('abc');
      expect(result.recorded).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not record when Flutterwave says the payment failed', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'success',
            data: { id: 999, status: 'failed', currency: 'NGN', tx_ref: `ledga-${customerId}-1` },
          }),
        ),
      );
      const result = await service().handleWebhook('my-hash', payload);
      expect(result.recorded).toBe(false);
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it('ignores non-payment events', async () => {
      const result = await service().handleWebhook('my-hash', {
        event: 'transfer.completed',
        data: {},
      });
      expect(result.recorded).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
