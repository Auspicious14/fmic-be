
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

    const customers = await this.customersService.findAll(userId);
    const normalizedSearchName = name.toLowerCase().trim();
    const normalizedSearchTag = descriptor?.toLowerCase().trim();

    if (!normalizedSearchName) {
      return { name, tag: descriptor, isNew: true, isAmbiguous: false };
    }

    // 1. Exact Name Match
    const exactMatch = customers.find(
      (c) => c.name.toLowerCase() === normalizedSearchName,
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
    const aliasMatch = customers.find((c) =>
      c.aliases?.some((a) => a.toLowerCase() === normalizedSearchName),
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
        (c) =>
          c.name.toLowerCase().includes(normalizedSearchName) &&
          c.tag?.toLowerCase() === normalizedSearchTag,
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
      .filter((c) => {
        const cName = c.name.toLowerCase();
        const cTag = c.tag?.toLowerCase() || '';
        const cAliases = c.aliases?.map((a) => a.toLowerCase()) || [];

        return (
          cName.includes(normalizedSearchName) ||
          normalizedSearchName.includes(cName) ||
          cAliases.some(
            (a) => a.includes(normalizedSearchName) || normalizedSearchName.includes(a),
          ) ||
          (normalizedSearchTag && cTag.includes(normalizedSearchTag))
        );
      })
      .map((c) => ({
        id: c._id.toString(),
        name: c.name,
        tag: c.tag,
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
