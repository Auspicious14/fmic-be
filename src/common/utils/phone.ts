/**
 * Normalises a Nigerian phone number to WhatsApp's format: digits only with
 * the country code, e.g. "0803 123 4567" / "+2348031234567" -> "2348031234567".
 * Returns null if it doesn't look like a phone number.
 */
export function normalizeNigerianPhone(input: string): string | null {
  let digits = String(input || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) digits = `234${digits.slice(1)}`;
  else if (digits.length === 10 && /^[789]/.test(digits)) digits = `234${digits}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}
