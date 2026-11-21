/**
 * Where a trader's customers pay them: their own bank or wallet account.
 * Shown on receipts so money goes straight to the trader, not through Ledga.
 */
export interface PayoutDetails {
  bank: string;
  accountNumber: string;
  accountName: string;
}

/** Banks and wallets traders use, with the ways people say them. */
export const NIGERIAN_BANKS: Array<{ name: string; aliases: string[] }> = [
  { name: 'OPay', aliases: ['opay', 'o pay', 'paycom'] },
  {
    name: 'Moniepoint',
    aliases: [
      'moniepoint',
      'monie point',
      'moniepoint mfb',
      'moniepoint microfinance',
    ],
  },
  { name: 'PalmPay', aliases: ['palmpay', 'palm pay'] },
  { name: 'Kuda', aliases: ['kuda', 'kuda bank', 'kuda mfb'] },
  {
    name: 'GTBank',
    aliases: [
      'gtbank',
      'gtb',
      'gt bank',
      'guaranty trust',
      'guaranty trust bank',
    ],
  },
  {
    name: 'Access Bank',
    aliases: ['access', 'access bank', 'diamond', 'diamond bank'],
  },
  {
    name: 'First Bank',
    aliases: ['first bank', 'firstbank', 'fbn', 'first bank of nigeria'],
  },
  { name: 'UBA', aliases: ['uba', 'united bank for africa'] },
  { name: 'Zenith Bank', aliases: ['zenith', 'zenith bank'] },
  { name: 'Fidelity Bank', aliases: ['fidelity', 'fidelity bank'] },
  { name: 'FCMB', aliases: ['fcmb', 'first city monument bank'] },
  { name: 'Union Bank', aliases: ['union', 'union bank'] },
  { name: 'Sterling Bank', aliases: ['sterling', 'sterling bank'] },
  { name: 'Wema Bank', aliases: ['wema', 'wema bank', 'alat'] },
  { name: 'Stanbic IBTC', aliases: ['stanbic', 'stanbic ibtc', 'ibtc'] },
  {
    name: 'Polaris Bank',
    aliases: ['polaris', 'polaris bank', 'skye', 'skye bank'],
  },
  { name: 'Ecobank', aliases: ['ecobank', 'eco bank'] },
  { name: 'Keystone Bank', aliases: ['keystone', 'keystone bank'] },
  { name: 'Providus Bank', aliases: ['providus', 'providus bank'] },
  { name: 'Jaiz Bank', aliases: ['jaiz', 'jaiz bank'] },
  { name: 'Unity Bank', aliases: ['unity', 'unity bank'] },
  { name: 'Globus Bank', aliases: ['globus', 'globus bank'] },
  { name: 'Titan Trust Bank', aliases: ['titan', 'titan trust'] },
  { name: 'Taj Bank', aliases: ['taj', 'taj bank'] },
  { name: 'Lotus Bank', aliases: ['lotus', 'lotus bank'] },
  { name: 'Premium Trust Bank', aliases: ['premium trust', 'premiumtrust'] },
  { name: 'Parallex Bank', aliases: ['parallex'] },
  { name: 'VFD Microfinance Bank', aliases: ['vfd', 'v bank', 'vbank'] },
  { name: 'FairMoney', aliases: ['fairmoney', 'fair money'] },
  { name: 'Carbon', aliases: ['carbon'] },
  { name: 'Paga', aliases: ['paga'] },
  { name: '9PSB', aliases: ['9psb', '9 psb', '9mobile psb'] },
  { name: 'MTN MoMo PSB', aliases: ['momo', 'mtn momo', 'momo psb'] },
  { name: 'Smartcash PSB', aliases: ['smartcash', 'airtel smartcash'] },
];

/** Wallets where the account number is the phone number without the 0. */
const PHONE_NUMBER_WALLETS = [
  'OPay',
  'PalmPay',
  'Moniepoint',
  'Kuda',
  'Paga',
  'MTN MoMo PSB',
  'Smartcash PSB',
  '9PSB',
];

const simplify = (text: string) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "gtb", "Opay", "access bank plc" -> the bank's usual name; null if unknown. */
export function matchBank(input: string): string | null {
  const wanted = simplify(input)
    .replace(/\b(plc|limited|ltd|nigeria)\b/g, '')
    .trim();
  if (!wanted) return null;
  for (const bank of NIGERIAN_BANKS) {
    if (simplify(bank.name) === wanted || bank.aliases.includes(wanted))
      return bank.name;
  }
  for (const bank of NIGERIAN_BANKS) {
    if (bank.aliases.some((alias) => wanted.startsWith(`${alias} `)))
      return bank.name;
  }
  return null;
}

/**
 * Checks what a trader typed and returns clean details, or a message saying
 * what's wrong. Unknown banks are kept as typed: the list isn't complete.
 */
export function parsePayoutDetails(input: {
  bank?: string | null;
  accountNumber?: string | null;
  accountName?: string | null;
}): { details: PayoutDetails } | { error: string } {
  const bankTyped = String(input.bank ?? '').trim();
  const bank = matchBank(bankTyped) ?? bankTyped;
  if (!bank)
    return { error: 'Which bank or app? e.g. OPay, Moniepoint, GTBank' };

  let accountNumber = String(input.accountNumber ?? '').replace(/\D/g, '');
  // OPay, PalmPay and co. use the phone number: "08031234567" -> "8031234567".
  if (
    accountNumber.length === 11 &&
    accountNumber.startsWith('0') &&
    PHONE_NUMBER_WALLETS.includes(bank)
  ) {
    accountNumber = accountNumber.slice(1);
  }
  if (!/^\d{10}$/.test(accountNumber)) {
    return { error: 'The account number should be 10 digits.' };
  }

  const accountName = String(input.accountName ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (accountName.length < 3) {
    return {
      error:
        'Add the name on the account, so customers know they are paying the right person.',
    };
  }
  return {
    details: { bank, accountNumber, accountName: accountName.slice(0, 80) },
  };
}

/** "OPay 8031234567 (Abdulganiyu Uthman)" */
export function formatPayout(details: PayoutDetails): string {
  return `${details.bank} ${details.accountNumber} (${details.accountName})`;
}
