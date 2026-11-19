import { ConfigService } from '@nestjs/config';
import { WhatsappService } from './whatsapp.service';
import { VoiceIntent } from '../voice/dto/voice-output.dto';
import { TransactionType } from '../transactions/schemas/transaction.schema';

describe('WhatsappService', () => {
  const phone = '2348031234567';
  const user = { _id: { toString: () => 'user-1' }, shopName: 'Mama Shop' };

  const api = {
    sendText: jest.fn(),
    sendButtons: jest.fn(),
    downloadMedia: jest.fn(),
  };
  const voiceService = { processAudio: jest.fn(), processTranscript: jest.fn() };
  const customersService = { create: jest.fn(), findOne: jest.fn() };
  const transactionsService = { create: jest.fn(), getDailySummary: jest.fn() };
  const receiptService = {
    buildReceiptData: jest.fn(() => ({})),
    generateWhatsAppMessage: jest.fn(() => 'receipt text'),
    buildWhatsAppUrl: jest.fn(() => 'https://wa.me/234800?text=receipt'),
  };

  let linkedUser: any;
  let pending: any;
  const seen = new Set<string>();

  const userModel = { findOne: jest.fn(() => ({ exec: async () => linkedUser })) };
  const pendingModel = {
    findOne: jest.fn(() => ({ exec: async () => pending })),
    findOneAndUpdate: jest.fn(async (_q: any, doc: any) => {
      pending = doc;
    }),
    findOneAndDelete: jest.fn(() => ({
      exec: async () => {
        const p = pending;
        pending = null;
        return p;
      },
    })),
    deleteOne: jest.fn(() => ({
      exec: async () => {
        pending = null;
      },
    })),
  };
  const seenModel = {
    create: jest.fn(async ({ messageId }: { messageId: string }) => {
      if (seen.has(messageId)) throw Object.assign(new Error('dup'), { code: 11000 });
      seen.add(messageId);
    }),
  };

  const service = new WhatsappService(
    { get: () => 'https://ledga.app' } as unknown as ConfigService,
    api as any,
    voiceService as any,
    customersService as any,
    transactionsService as any,
    receiptService as any,
    userModel as any,
    pendingModel as any,
    seenModel as any,
  );

  const creditSale = {
    transactions: [
      {
        intent: VoiceIntent.CREDIT_SALE,
        resolvedCustomer: { name: 'Gani', isNew: true, isAmbiguous: false },
        items: [{ product_name: 'akara', product_id: null, quantity: 3, unit_price: 300 }],
        total_amount: 900,
        amount: 900,
        reasoning_summary: 'Gani bought 3 akara',
      },
    ],
    overall_transcript: 'Gani o ra akara meta, 900',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    linkedUser = user;
    pending = null;
    process.env.PUBLIC_API_URL = 'https://api.example.com';
  });

  it('tells an unknown number how to link their shop', async () => {
    linkedUser = null;
    await service.handleMessage({ id: 'm1', from: phone, type: 'text', text: { body: 'hi' } });
    expect(api.sendText).toHaveBeenCalledWith(phone, expect.stringContaining('Settings → WhatsApp'));
    expect(voiceService.processTranscript).not.toHaveBeenCalled();
  });

  it('turns a voice note into a ✅/❌ question', async () => {
    api.downloadMedia.mockResolvedValue({ buffer: Buffer.from('ogg'), mimetype: 'audio/ogg' });
    voiceService.processAudio.mockResolvedValue(creditSale);

    await service.handleMessage({ id: 'm2', from: phone, type: 'audio', audio: { id: 'media-1' } });

    expect(voiceService.processAudio).toHaveBeenCalledWith(
      { buffer: Buffer.from('ogg'), mimetype: 'audio/ogg' },
      'user-1',
    );
    const [, body, buttons] = api.sendButtons.mock.calls[0];
    expect(body).toContain('Gani (new customer) owes ₦900 for 3 × akara');
    expect(buttons.map((b: any) => b.id)).toEqual(['ledga_confirm', 'ledga_cancel']);
    expect(pending.sourceMessageId).toBe('m2');
  });

  it('ignores a duplicate delivery of the same message', async () => {
    voiceService.processTranscript.mockResolvedValue(creditSale);
    const msg = { id: 'dup-1', from: phone, type: 'text', text: { body: 'Gani buy akara' } };
    await service.handleMessage(msg);
    await service.handleMessage(msg);
    expect(voiceService.processTranscript).toHaveBeenCalledTimes(1);
  });

  it('on ✅ creates the new customer, saves once, and returns a receipt link', async () => {
    pending = { phone, userId: 'user-1', sourceMessageId: 'm3', interpretation: creditSale };
    customersService.create.mockResolvedValue({ _id: { toString: () => 'cust-1' } });
    transactionsService.create.mockResolvedValue({ _id: { toString: () => 'tx-1' } });
    customersService.findOne.mockResolvedValue({ name: 'Gani', phone: '', outstandingBalance: 900 });

    await service.handleMessage({
      id: 'm4',
      from: phone,
      type: 'interactive',
      interactive: { button_reply: { id: 'ledga_confirm' } },
    });

    expect(customersService.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Gani' }),
      'user-1',
    );
    expect(transactionsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cust-1',
        type: TransactionType.CREDIT,
        idempotencyKey: 'wa-m3-0',
        items: [{ productName: 'akara', productId: undefined, quantity: 3, unitPriceAtSale: 300 }],
      }),
      'user-1',
    );
    const reply = api.sendText.mock.calls.at(-1)[1];
    expect(reply).toContain('Gani now owes ₦900');
    expect(reply).toContain('https://api.example.com/api/r/tx-1?s=');
  });

  it('accepts a typed "yes" as confirmation', async () => {
    pending = { phone, userId: 'user-1', sourceMessageId: 'm5', interpretation: { transactions: [] } };
    await service.handleMessage({ id: 'm6', from: phone, type: 'text', text: { body: 'Yes' } });
    expect(pendingModel.findOneAndDelete).toHaveBeenCalled();
    expect(voiceService.processTranscript).not.toHaveBeenCalled();
  });

  it('on ❌ saves nothing', async () => {
    pending = { phone, userId: 'user-1', sourceMessageId: 'm7', interpretation: creditSale };
    await service.handleMessage({
      id: 'm8',
      from: phone,
      type: 'interactive',
      interactive: { button_reply: { id: 'ledga_cancel' } },
    });
    expect(transactionsService.create).not.toHaveBeenCalled();
    expect(api.sendText).toHaveBeenCalledWith(phone, expect.stringContaining('Nothing was saved'));
  });

  it('asks again when nothing could be understood', async () => {
    voiceService.processTranscript.mockResolvedValue({
      transactions: [{ intent: VoiceIntent.UNCLEAR, resolvedCustomer: { name: 'Unknown' } }],
    });
    await service.handleMessage({ id: 'm9', from: phone, type: 'text', text: { body: 'hmm' } });
    expect(api.sendButtons).not.toHaveBeenCalled();
    expect(api.sendText).toHaveBeenCalledWith(phone, expect.stringContaining('talk am again'));
  });
});
