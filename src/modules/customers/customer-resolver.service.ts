import { Injectable, Logger } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomerDocument } from './schemas/customer.schema';

export interface ResolvedCustomer {
  customerId?: string;
  name: string;
  tag?: string;
  isNew: boolean;
  isAmbiguous: boolean;
  potentialMatches?: Array<{ id: string; name: string; tag?: string }>;
}

@Injectable()
export class CustomerResolverService {
  private readonly logger = new Logger(CustomerResolverService.name);

  constructor(private readonly customersService: CustomersService) {}

  async resolve(
    name: string,
    descriptor?: string,
    userId?: string,
  ): Promise<ResolvedCustomer> {
    if (!userId) {
      return { name, tag: descriptor, isNew: true, isAmbiguous: false };
    }

    const result = await this.customersService.findAll(userId);
    const customers: CustomerDocument[] = result.customers;
    const normalizedSearchName = name.toLowerCase().trim();
    const normalizedSearchTag = descriptor?.toLowerCase().trim();

    if (!normalizedSearchName) {
      return { name, tag: descriptor, isNew: true, isAmbiguous: false };
    }

    // 1. Exact Name Match
    const exactMatch = customers.find(
      (customer: CustomerDocument) =>
        customer.name.toLowerCase() === normalizedSearchName,
    );
    if (exactMatch) {
      return {
        customerId: exactMatch._id.toString(),
        name: exactMatch.name,
        tag: exactMatch.tag,
        isNew: false,
        isAmbiguous: false,
      };
    }

    // 2. Alias Match
    const aliasMatch = customers.find((customer: CustomerDocument) =>
      customer.aliases?.some(
        (alias: string) => alias.toLowerCase() === normalizedSearchName,
      ),
    );
    if (aliasMatch) {
      return {
        customerId: aliasMatch._id.toString(),
        name: aliasMatch.name,
        tag: aliasMatch.tag,
        isNew: false,
        isAmbiguous: false,
      };
    }

    // 3. Descriptor-Based Matching
    if (normalizedSearchTag) {
      const tagMatch = customers.find(
        (customer: CustomerDocument) =>
          customer.name.toLowerCase().includes(normalizedSearchName) &&
          customer.tag?.toLowerCase() === normalizedSearchTag,
      );
      if (tagMatch) {
        return {
          customerId: tagMatch._id.toString(),
          name: tagMatch.name,
          tag: tagMatch.tag,
          isNew: false,
          isAmbiguous: false,
        };
      }
    }

    // 4. Fuzzy Matching (Similarity Check)
    const potentialMatches = customers
      .filter((customer: CustomerDocument) => {
        const cName = customer.name.toLowerCase();
        const cTag = customer.tag?.toLowerCase() || '';
        const cAliases =
          customer.aliases?.map((alias: string) => alias.toLowerCase()) || [];

        return (
          cName.includes(normalizedSearchName) ||
          normalizedSearchName.includes(cName) ||
          // Speech models clip names: "Trayo" for "Motunrayo", "Motun" for "Motunrayo".
          soundsAlike(normalizedSearchName, cName) ||
          cAliases.some((alias: string) => soundsAlike(normalizedSearchName, alias)) ||
          cAliases.some(
            (alias: string) =>
              alias.includes(normalizedSearchName) ||
              normalizedSearchName.includes(alias),
          ) ||
          (normalizedSearchTag && cTag.includes(normalizedSearchTag))
        );
      })
      .map((customer: CustomerDocument) => ({
        id: customer._id.toString(),
        name: customer.name,
        tag: customer.tag,
      }));

    if (potentialMatches.length > 0) {
      return {
        name,
        tag: descriptor,
        isNew: false,
        isAmbiguous: true,
        potentialMatches,
      };
    }

    // 5. New Customer Fallback
    return {
      name,
      tag: descriptor,
      isNew: true,
      isAmbiguous: false,
    };
  }
}

/** Lowercase letters only, tone marks removed ("Mọ́túnráyọ̀" -> "motunrayo"). */
function plainName(value: string): string {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length];
}

/**
 * True when a heard name is probably a known customer's name, misheard or
 * clipped by speech-to-text. Only used to ASK the trader ("Did you mean…?"),
 * never to pick a customer silently.
 */
const TITLES = new Set([
  'mama', 'baba', 'iya', 'iyá', 'alhaji', 'alhaja', 'mr', 'mrs', 'miss',
  'aunty', 'auntie', 'uncle', 'oga', 'madam', 'bro', 'brother', 'sister',
  'sis', 'chief', 'dr', 'pastor', 'iyalode', 'egbon', 'mummy', 'daddy',
]);

/** Name without titles: "Mama Tunde" -> ["tunde"]. */
function nameParts(value: string): string[] {
  return (value || '')
    .split(/\s+/)
    .map(plainName)
    .filter((part) => part && !TITLES.has(part));
}

export function soundsAlike(heard: string, known: string): boolean {
  const a = nameParts(heard).join('');
  const knownParts = nameParts(known);
  const b = knownParts[0] ?? '';
  const full = knownParts.join('');
  if (a.length < 4 || b.length < 3) return false;

  for (const target of new Set([b, full])) {
    const shorter = Math.min(a.length, target.length);
    let prefix = 0;
    while (prefix < shorter && a[prefix] === target[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < shorter &&
      a[a.length - 1 - suffix] === target[target.length - 1 - suffix]
    ) {
      suffix++;
    }
    // Shared start or ending covering most of the shorter name.
    if (Math.max(prefix, suffix) >= 4 && Math.max(prefix, suffix) >= shorter * 0.6) {
      return true;
    }
    // Small spelling differences ("Gani" / "Ganiyu" handled above; "Kamau" / "Kamao" here).
    const distance = levenshtein(a, target);
    if (distance / Math.max(a.length, target.length) <= 0.25) return true;
  }
  return false;
}
