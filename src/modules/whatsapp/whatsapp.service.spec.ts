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
    sendImage: jest.fn(),
    downloadMedia: jest.fn(),
  };
  const receiptImageService = { render: jest.fn() };
  const ledgerQueryService = {
    debtors: jest.fn(),
    entries: jest.fn(),
    customerHistory: jest.fn(),
  };
  const voiceService = {
    processAudio: jest.fn(),
    processTranscript: jest.fn(),
    reviseTranscript: jest.fn(),
  };
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

  const userModel = {
    findOne: jest.fn(() => ({ exec: async () => linkedUser })),
    updateOne: jest.fn(() => ({ exec: async () => ({}) })),
  };
  const pendingModel = {
    findOne: jest.fn(() => ({ exec: async () => pending })),
    findOneAndUpdate: jest.fn(async (_q: any, doc: any) => {
      pending = doc;
    }),
    findOneAndDelete: jest.fn((q: any) => ({
      exec: async () => {
        const p = pending;
        if (!p) return null;
        if (q?.['interpretation.transactions.0'] && !p.interpretation?.transactions?.length) {
          return null;
        }
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
    receiptImageService as any,
    ledgerQueryService as any,
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
    receiptImageService.render.mockResolvedValue(null);
    process.env.BACKEND_API_URL = 'https://api.example.com';
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

  it('on ✅ sends the receipt as a picture with the pay link in the caption', async () => {
    pending = { phone, userId: 'user-1', sourceMessageId: 'm3', interpretation: creditSale };
    customersService.create.mockResolvedValue({ _id: { toString: () => 'cust-1' } });
    transactionsService.create.mockResolvedValue({ _id: { toString: () => 'tx-1' } });
    customersService.findOne.mockResolvedValue({ name: 'Gani', phone: '', outstandingBalance: 900 });
    receiptService.buildReceiptData.mockReturnValueOnce({
      businessName: 'Mama Shop',
      transactionType: 'credit',
      totalAmount: 900,
      outstandingBalance: 900,
      payUrl: 'https://api.example.com/api/pay/cust-1?s=sig',
    } as any);
    receiptImageService.render.mockResolvedValue(Buffer.from('png'));

    await service.handleMessage({
      id: 'm4b',
      from: phone,
      type: 'interactive',
      interactive: { button_reply: { id: 'ledga_confirm' } },
    });

    const [to, png, caption] = api.sendImage.mock.calls[0];
    expect(to).toBe(phone);
    expect(png).toEqual(Buffer.from('png'));
    expect(caption).toBe(
      'Receipt from Mama Shop. You owe ₦900 in total.\nPay online: https://api.example.com/api/pay/cust-1?s=sig',
    );
    const reply = api.sendText.mock.calls.at(-1)[1];
    expect(reply).toContain('Forward the receipt to Gani');
    expect(reply).not.toContain('/api/r/');
  });

  it('falls back to the receipt link if the picture cannot be sent', async () => {
    pending = { phone, userId: 'user-1', sourceMessageId: 'm3c', interpretation: creditSale };
    customersService.create.mockResolvedValue({ _id: { toString: () => 'cust-1' } });
    transactionsService.create.mockResolvedValue({ _id: { toString: () => 'tx-9' } });
    customersService.findOne.mockResolvedValue({ name: 'Gani', phone: '', outstandingBalance: 900 });
    receiptImageService.render.mockResolvedValue(Buffer.from('png'));
    api.sendImage.mockRejectedValueOnce(new Error('upload failed'));

    await service.handleMessage({
      id: 'm4c',
      from: phone,
      type: 'interactive',
      interactive: { button_reply: { id: 'ledga_confirm' } },
    });

    expect(api.sendText.mock.calls.at(-1)[1]).toContain('https://api.example.com/api/r/tx-9?s=');
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

  it('shows ledger warnings next to the entry', async () => {
    voiceService.processTranscript.mockResolvedValue({
      transactions: [
        {
          intent: VoiceIntent.PAYMENT,
          resolvedCustomer: { name: 'Kamau', customerId: 'c1', isNew: false, isAmbiguous: false },
          items: [],
          total_amount: 5000,
          amount: 5000,
          warnings: ["Kamau doesn't owe you anything. Saving this puts them ₦5,000 in credit."],
        },
      ],
    });
    await service.handleMessage({ id: 'w1', from: phone, type: 'text', text: { body: 'Kamau don pay 5000' } });
    const [, body] = api.sendButtons.mock.calls[0];
    expect(body).toContain('Kamau paid ₦5,000');
    expect(body).toContain("⚠️ Kamau doesn't owe you anything");
  });

  it('never offers to save a sale with no price', async () => {
    voiceService.processTranscript.mockResolvedValue({
      transactions: [
        {
          intent: VoiceIntent.CREDIT_SALE,
          needs_price: true,
          resolvedCustomer: { name: 'Baba Sola', isNew: true, isAmbiguous: false },
          items: [{ product_name: 'peak milk', quantity: 2, unit_price: 0 }],
          total_amount: 0,
        },
      ],
      overall_transcript: 'Baba Sola mu peak milk meji',
    });
    await service.handleMessage({ id: 'w2', from: phone, type: 'text', text: { body: 'Baba Sola mu peak milk meji' } });
    expect(api.sendButtons).not.toHaveBeenCalled();
    expect(api.sendText).toHaveBeenCalledWith(phone, expect.stringContaining('I no hear the price'));
    // Nothing to save, but what was heard is kept so "na 1800" can fix it.
    expect(pending.interpretation.transactions).toEqual([]);
  });

  describe('corrections by reply', () => {
    const kamauSale = {
      transactions: [
        {
          intent: VoiceIntent.CREDIT_SALE,
          resolvedCustomer: { name: 'Kamau', customerId: 'c1', isNew: false, isAmbiguous: false },
          items: [{ product_name: 'Peak Milk', quantity: 2, unit_price: 800 }],
          total_amount: 1600,
          amount: 1600,
        },
      ],
      overall_transcript: 'Kamau buy 2 peak milk for 1600',
    };
    const mamaPending = () => ({
      phone,
      userId: 'user-1',
      sourceMessageId: 'v1',
      interpretation: {
        overall_transcript: 'Mama buy 2 pig milk for 1600',
        transactions: [{ intent: VoiceIntent.CREDIT_SALE, resolvedCustomer: { name: 'Mama', isNew: true } }],
      },
    });

    it('fixes the waiting entry from a typed reply and asks again', async () => {
      pending = mamaPending();
      voiceService.reviseTranscript.mockResolvedValue({
        action: 'correct',
        transcript: 'Kamau buy 2 peak milk for 1600',
      });
      voiceService.processTranscript.mockResolvedValue(kamauSale);

      await service.handleMessage({
        id: 'c1',
        from: phone,
        type: 'text',
        text: { body: "No, peak milk and the name is not mama, it's Kamau" },
      });

      expect(voiceService.reviseTranscript).toHaveBeenCalledWith(
        'Mama buy 2 pig milk for 1600',
        "No, peak milk and the name is not mama, it's Kamau",
        'user-1',
      );
      expect(voiceService.processTranscript).toHaveBeenCalledWith(
        { transcript: 'Kamau buy 2 peak milk for 1600' },
        'user-1',
      );
      const [, body] = api.sendButtons.mock.calls[0];
      expect(body).toContain('Okay, I don change am');
      expect(body).toContain('Kamau owes ₦1,600 for 2 × Peak Milk');
      expect(transactionsService.create).not.toHaveBeenCalled(); // never saves on its own
      expect(pending.sourceMessageId).toBe('c1');
    });

    it('fixes the waiting entry from a voice note too', async () => {
      pending = mamaPending();
      api.downloadMedia.mockResolvedValue({ buffer: Buffer.from('ogg'), mimetype: 'audio/ogg' });
      voiceService.processAudio.mockResolvedValue({ transactions: [], overall_transcript: 'no be Mama, na Kamau' });
      voiceService.reviseTranscript.mockResolvedValue({
        action: 'correct',
        transcript: 'Kamau buy 2 pig milk for 1600',
      });
      voiceService.processTranscript.mockResolvedValue(kamauSale);

      await service.handleMessage({ id: 'c2', from: phone, type: 'audio', audio: { id: 'media-2' } });

      expect(voiceService.reviseTranscript).toHaveBeenCalledWith(
        'Mama buy 2 pig milk for 1600',
        'no be Mama, na Kamau',
        'user-1',
      );
      expect(api.sendButtons).toHaveBeenCalled();
    });

    it('asks one question when the reply is unclear and keeps the entry', async () => {
      pending = mamaPending();
      voiceService.reviseTranscript.mockResolvedValue({
        action: 'unclear',
        question: 'Wetin I go change?',
      });
      await service.handleMessage({ id: 'c3', from: phone, type: 'text', text: { body: 'e no correct' } });
      expect(api.sendText).toHaveBeenCalledWith(phone, 'Wetin I go change?');
      expect(pending.sourceMessageId).toBe('v1');
    });

    it('treats a different sale as a new entry and says the old one was not saved', async () => {
      pending = mamaPending();
      voiceService.reviseTranscript.mockResolvedValue({ action: 'new' });
      voiceService.processTranscript.mockResolvedValue(creditSale);
      await service.handleMessage({ id: 'c4', from: phone, type: 'text', text: { body: 'Gani buy 3 akara 900' } });
      const [, body] = api.sendButtons.mock.calls[0];
      expect(body).toContain('I no save the one before');
      expect(body).toContain('Gani (new customer) owes ₦900');
    });

    it('treats the reply as new if the correction check fails', async () => {
      pending = mamaPending();
      voiceService.reviseTranscript.mockRejectedValue(new Error('groq down'));
      voiceService.processTranscript.mockResolvedValue(creditSale);
      await service.handleMessage({ id: 'c5', from: phone, type: 'text', text: { body: 'Gani buy 3 akara 900' } });
      expect(voiceService.processTranscript).toHaveBeenCalledWith({ transcript: 'Gani buy 3 akara 900' }, 'user-1');
      expect(api.sendButtons).toHaveBeenCalled();
    });

    it('a price reply completes a sale that had no price', async () => {
      pending = {
        phone,
        userId: 'user-1',
        sourceMessageId: 'v2',
        interpretation: { overall_transcript: 'Baba Sola mu indomie meji', transactions: [] },
      };
      voiceService.reviseTranscript.mockResolvedValue({
        action: 'correct',
        transcript: 'Baba Sola mu indomie meji, 1800 total',
      });
      voiceService.processTranscript.mockResolvedValue(creditSale);
      await service.handleMessage({ id: 'c6', from: phone, type: 'text', text: { body: 'na 1800' } });
      expect(voiceService.processTranscript).toHaveBeenCalledWith(
        { transcript: 'Baba Sola mu indomie meji, 1800 total' },
        'user-1',
      );
      expect(api.sendButtons).toHaveBeenCalled();
    });

    it('"yes" while only a price question is waiting saves nothing and keeps it', async () => {
      pending = {
        phone,
        userId: 'user-1',
        sourceMessageId: 'v3',
        interpretation: { overall_transcript: 'Baba Sola mu indomie meji', transactions: [] },
      };
      await service.handleMessage({ id: 'c7', from: phone, type: 'text', text: { body: 'yes' } });
      expect(transactionsService.create).not.toHaveBeenCalled();
      expect(api.sendText).toHaveBeenCalledWith(phone, expect.stringContaining('Nothing is ready to save yet'));
      expect(pending).not.toBeNull();
    });
  });

  describe('questions', () => {
    const ask = (question: any, resolvedCustomer: any = { name: '', isNew: false, isAmbiguous: false }) =>
      voiceService.processTranscript.mockResolvedValue({
        transactions: [{ intent: VoiceIntent.QUESTION, resolvedCustomer, question }],
        overall_transcript: 'question',
      });
    let questionId = 0;
    const send = (body: string) =>
      service.handleMessage({ id: `q-${++questionId}`, from: phone, type: 'text', text: { body } });

    it('"who owe me?" lists debtors, biggest first, and saves nothing', async () => {
      ask({ topic: 'debtors' });
      ledgerQueryService.debtors.mockResolvedValue({
        customers: [
          { name: 'Kamau', outstandingBalance: 5000 },
          { name: 'Tunde', tag: 'mechanic', outstandingBalance: 1400 },
        ],
        total: 6400,
      });

      await send('who owe me?');

      expect(api.sendText).toHaveBeenCalledWith(
        phone,
        '📒 2 customers owe you ₦6,400:\n1. Kamau: ₦5,000\n2. Tunde (mechanic): ₦1,400',
      );
      expect(api.sendButtons).not.toHaveBeenCalled();
      expect(pending).toBeNull();
    });

    it('says so when nobody owes anything', async () => {
      ask({ topic: 'debtors' });
      ledgerQueryService.debtors.mockResolvedValue({ customers: [], total: 0 });
      await send('who owe me');
      expect(api.sendText).toHaveBeenCalledWith(phone, expect.stringContaining('Nobody owes you'));
    });

    it('"how much Kamau owe?" gives the balance and the last entries', async () => {
      ask({ topic: 'customer_balance' }, { customerId: 'c1', name: 'Kamau', isNew: false, isAmbiguous: false });
      ledgerQueryService.customerHistory.mockResolvedValue({
        customer: { name: 'Kamau', outstandingBalance: 3000 },
        recent: [
          { type: TransactionType.PAYMENT, totalAmount: 2000, createdAt: new Date('2026-11-20T10:00:00Z') },
          {
            type: TransactionType.CREDIT,
            totalAmount: 5000,
            items: [{ productName: 'Rice', quantity: 2 }],
            createdAt: new Date('2026-11-18T10:00:00Z'),
          },
        ],
      });

      await send('how much Kamau owe');

      const answer = api.sendText.mock.calls[0][1];
      expect(answer).toContain('Kamau owes you ₦3,000.');
      expect(answer).toContain('• 20 Nov: paid ₦2,000');
      expect(answer).toContain('• 18 Nov: took 2 × Rice, ₦5,000');
    });

    it('does not guess when the customer is not in the book', async () => {
      ask({ topic: 'customer_balance' }, { name: 'Zainab', isNew: true, isAmbiguous: false });
      await send('how much Zainab owe');
      expect(api.sendText).toHaveBeenCalledWith(phone, 'I no find "Zainab" for your book.');
      expect(ledgerQueryService.customerHistory).not.toHaveBeenCalled();
    });

    it('"who pay today?" lists payments with the total', async () => {
      ask({ topic: 'payments', period: 'today' });
      ledgerQueryService.entries.mockResolvedValue({
        entries: [
          { type: TransactionType.PAYMENT, totalAmount: 1400, customer: { name: 'Alfa' }, createdAt: new Date('2026-11-21T12:41:00Z') },
        ],
        total: 1400,
      });

      await send('who pay today');

      expect(ledgerQueryService.entries).toHaveBeenCalledWith(
        'user-1',
        TransactionType.PAYMENT,
        expect.objectContaining({ label: 'today' }),
      );
      const answer = api.sendText.mock.calls[0][1];
      expect(answer).toContain('💰 You collected ₦1,400 today:');
      expect(answer).toMatch(/• Alfa: ₦1,400, 1:41\s?pm/i);
    });

    it('answers a question asked while an entry is waiting, and keeps the entry', async () => {
      pending = {
        phone,
        userId: 'user-1',
        sourceMessageId: 'v9',
        interpretation: { overall_transcript: 'Alfa buy rice 1400', transactions: [{ intent: VoiceIntent.CREDIT_SALE }] },
      };
      voiceService.reviseTranscript.mockResolvedValue({ action: 'new' });
      ask({ topic: 'debtors' });
      ledgerQueryService.debtors.mockResolvedValue({ customers: [], total: 0 });

      await send('who owe me');

      expect(api.sendText).toHaveBeenCalledWith(phone, expect.stringContaining('Nobody owes you'));
      expect(pending.sourceMessageId).toBe('v9');
    });
  });

  describe('where customers pay', () => {
    const payoutMessage = (payout: any) =>
      voiceService.processTranscript.mockResolvedValue({
        transactions: [
          {
            intent: VoiceIntent.PAYOUT_DETAILS,
            resolvedCustomer: { name: '', isNew: false, isAmbiguous: false },
            payout,
          },
        ],
        overall_transcript: 'my account',
      });

    it('saves "my account na OPay 08031234567, Abdulganiyu Uthman" and shows it back', async () => {
      payoutMessage({ bank: 'opay', accountNumber: '08031234567', accountName: 'Abdulganiyu Uthman' });
      await service.handleMessage({ id: 'p1', from: phone, type: 'text', text: { body: 'my account na opay' } });
      expect(userModel.updateOne).toHaveBeenCalledWith(
        { _id: 'user-1' },
        { payoutBank: 'OPay', payoutAccountNumber: '8031234567', payoutAccountName: 'Abdulganiyu Uthman' },
      );
      expect(api.sendText).toHaveBeenCalledWith(
        phone,
        expect.stringContaining('🏦 OPay 8031234567 (Abdulganiyu Uthman)'),
      );
      expect(api.sendButtons).not.toHaveBeenCalled();
    });

    it('says what is missing instead of saving a bad account', async () => {
      payoutMessage({ bank: 'GTB', accountNumber: '12345', accountName: 'Ade' });
      await service.handleMessage({ id: 'p2', from: phone, type: 'text', text: { body: 'my gtb 12345' } });
      expect(userModel.updateOne).not.toHaveBeenCalled();
      expect(api.sendText).toHaveBeenCalledWith(phone, expect.stringContaining('10 digits'));
    });

    it("puts the shop's account in the receipt caption instead of a pay link", async () => {
      pending = { phone, userId: 'user-1', sourceMessageId: 'p3', interpretation: creditSale };
      customersService.create.mockResolvedValue({ _id: { toString: () => 'cust-1' } });
      transactionsService.create.mockResolvedValue({ _id: { toString: () => 'tx-1' } });
      customersService.findOne.mockResolvedValue({ name: 'Gani', phone: '', outstandingBalance: 900 });
      receiptService.buildReceiptData.mockReturnValueOnce({
        businessName: 'Mama Shop',
        transactionType: 'credit',
        totalAmount: 900,
        outstandingBalance: 900,
        payTo: { bank: 'OPay', accountNumber: '8031234567', accountName: 'Abdulganiyu Uthman' },
        payUrl: null,
      } as any);
      receiptImageService.render.mockResolvedValue(Buffer.from('png'));

      await service.handleMessage({
        id: 'p4',
        from: phone,
        type: 'interactive',
        interactive: { button_reply: { id: 'ledga_confirm' } },
      });

      expect(api.sendImage.mock.calls[0][2]).toBe(
        'Receipt from Mama Shop. You owe ₦900 in total.\nPay by transfer: OPay 8031234567 (Abdulganiyu Uthman)',
      );
    });

    it('suggests adding an account after a credit sale when none is set', async () => {
      pending = { phone, userId: 'user-1', sourceMessageId: 'p5', interpretation: creditSale };
      customersService.create.mockResolvedValue({ _id: { toString: () => 'cust-1' } });
      transactionsService.create.mockResolvedValue({ _id: { toString: () => 'tx-1' } });
      customersService.findOne.mockResolvedValue({ name: 'Gani', phone: '', outstandingBalance: 900 });

      await service.handleMessage({
        id: 'p6',
        from: phone,
        type: 'interactive',
        interactive: { button_reply: { id: 'ledga_confirm' } },
      });

      expect(api.sendText.mock.calls.at(-1)[1]).toContain('Tell customers where to pay you');
    });
  });
});
