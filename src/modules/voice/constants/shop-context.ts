/**
 * Builds the "what this shop knows" block that is sent to the AI with every
 * voice note. Giving the model the shop's real customer names and product
 * catalogue is the cheapest accuracy win we have: it can map "Mama Tun day"
 * to "Mama Tunde" and fill in a price the trader didn't say.
 */

const MAX_CUSTOMERS = 200;
const MAX_PRODUCTS = 200;

export interface ShopContextCustomer {
  name: string;
  tag?: string;
  aliases?: string[];
  outstandingBalance?: number;
}

export interface ShopContextProduct {
  name: string;
  currentUnitPrice?: number;
}

export function buildShopContextBlock(
  customers: ShopContextCustomer[] = [],
  products: ShopContextProduct[] = [],
): string {
  const customerLines = customers.slice(0, MAX_CUSTOMERS).map((c) => {
    const parts = [c.name];
    if (c.tag) parts.push(`tag: ${c.tag}`);
    if (c.aliases?.length) parts.push(`also called: ${c.aliases.join(', ')}`);
    if (c.outstandingBalance) parts.push(`owes: ${c.outstandingBalance}`);
    return `- ${parts.join(' | ')}`;
  });

  const productLines = products.slice(0, MAX_PRODUCTS).map((p) => {
    const price =
      typeof p.currentUnitPrice === 'number' && p.currentUnitPrice > 0
        ? ` | unit price: ${p.currentUnitPrice}`
        : '';
    return `- ${p.name}${price}`;
  });

  return [
    'SHOP CONTEXT (use these exact spellings when the speaker means one of them):',
    'KNOWN CUSTOMERS:',
    customerLines.length ? customerLines.join('\n') : '- (none yet)',
    'KNOWN PRODUCTS:',
    productLines.length ? productLines.join('\n') : '- (none yet)',
  ].join('\n');
}
