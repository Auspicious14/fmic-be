import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Unguessable public links (pay links, public receipts) without logins.
 * The signature is an HMAC of "<kind>:<id>" with a server secret, so a
 * customer can open their own link but can't guess anyone else's.
 */
function secret(): string {
  return (
    process.env.LINK_SIGNING_SECRET ||
    process.env.JWT_SECRET ||
    'ledga-dev-link-secret'
  );
}

export function signLink(kind: string, id: string): string {
  return createHmac('sha256', secret())
    .update(`${kind}:${id}`)
    .digest('base64url')
    .slice(0, 22);
}

export function verifyLink(kind: string, id: string, signature?: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signLink(kind, id));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Public base URL of this API, e.g. https://ledga-api.vercel.app (no /api). */
export function publicApiUrl(): string | null {
  const url = process.env.PUBLIC_API_URL;
  return url ? url.replace(/\/+$/, '') : null;
}

/** "Pay now" link for a customer's outstanding balance, or null if payments are off. */
export function buildPayUrl(customerId: string): string | null {
  const base = publicApiUrl();
  if (!base || !process.env.FLW_SECRET_KEY || !customerId) return null;
  return `${base}/api/pay/${customerId}?s=${signLink('pay', customerId)}`;
}

/** Public receipt link a customer can open without logging in. */
export function buildPublicReceiptUrl(transactionId: string): string | null {
  const base = publicApiUrl();
  if (!base || !transactionId) return null;
  return `${base}/api/r/${transactionId}?s=${signLink('receipt', transactionId)}`;
}
