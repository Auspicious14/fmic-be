import { formatPayout, matchBank, parsePayoutDetails } from './banks';

describe('banks', () => {
  it.each([
    ['opay', 'OPay'],
    ['Opay', 'OPay'],
    ['Monie point', 'Moniepoint'],
    ['palm pay', 'PalmPay'],
    ['GTB', 'GTBank'],
    ['Guaranty Trust Bank', 'GTBank'],
    ['access bank plc', 'Access Bank'],
    ['First Bank of Nigeria', 'First Bank'],
    ['alat', 'Wema Bank'],
  ])('matches "%s" to %s', (typed, name) => {
    expect(matchBank(typed)).toBe(name);
  });

  it('returns null for a bank it does not know', () => {
    expect(matchBank('Mama Bank of Ilorin')).toBeNull();
  });

  it('turns an OPay phone number into the account number', () => {
    expect(
      parsePayoutDetails({
        bank: 'opay',
        accountNumber: '0803 123 4567',
        accountName: ' Abdulganiyu  Uthman ',
      }),
    ).toEqual({
      details: {
        bank: 'OPay',
        accountNumber: '8031234567',
        accountName: 'Abdulganiyu Uthman',
      },
    });
  });

  it('does not strip the 0 for a normal bank account', () => {
    expect(
      parsePayoutDetails({
        bank: 'GTB',
        accountNumber: '01234567891',
        accountName: 'Ade',
      }),
    ).toEqual({
      error: 'The account number should be 10 digits.',
    });
  });

  it('keeps an unknown bank as typed', () => {
    const result = parsePayoutDetails({
      bank: 'Mama Bank',
      accountNumber: '0123456789',
      accountName: 'Ade Ola',
    });
    expect(result).toEqual({
      details: {
        bank: 'Mama Bank',
        accountNumber: '0123456789',
        accountName: 'Ade Ola',
      },
    });
  });

  it('asks for the account name', () => {
    expect(
      parsePayoutDetails({ bank: 'opay', accountNumber: '8031234567' }),
    ).toEqual({
      error: expect.stringContaining('name on the account'),
    });
  });

  it('formats for receipts', () => {
    expect(
      formatPayout({
        bank: 'OPay',
        accountNumber: '8031234567',
        accountName: 'Abdulganiyu Uthman',
      }),
    ).toBe('OPay 8031234567 (Abdulganiyu Uthman)');
  });
});
