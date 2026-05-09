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
