
import { ApiProperty } from '@nestjs/swagger';

export enum VoiceIntent {
  CREDIT_SALE = 'CREDIT_SALE',
  PAYMENT = 'PAYMENT',
  ADJUSTMENT = 'ADJUSTMENT',
  PRODUCT_PRICE_UPDATE = 'PRODUCT_PRICE_UPDATE',
  DAILY_SUMMARY = 'DAILY_SUMMARY',
  UNKNOWN = 'UNKNOWN',
}

export class ResolvedCustomerDto {
  @ApiProperty({ required: false })
  customerId?: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ required: false })
  tag?: string;

  @ApiProperty()
  isNew: boolean;

  @ApiProperty()
  isAmbiguous: boolean;

  @ApiProperty({ required: false })
  potentialMatches?: Array<{ id: string; name: string; tag?: string }>;
}

export class VoiceTransactionItem {
  @ApiProperty()
  product_name: string;

  @ApiProperty({ required: false })
  product_id?: string;

  @ApiProperty()
  quantity: number;

  @ApiProperty()
  unit_price: number;
}

export class VoiceTransactionData {
  @ApiProperty({ enum: VoiceIntent })
  intent: VoiceIntent;

  @ApiProperty({ type: ResolvedCustomerDto })
  resolvedCustomer: ResolvedCustomerDto;

  @ApiProperty({ type: [VoiceTransactionItem] })
  items: VoiceTransactionItem[];

  @ApiProperty()
  total_amount: number;

  @ApiProperty({ required: false, description: 'Direct amount for payments' })
  amount?: number;

  @ApiProperty({ example: 'credit' })
  transaction_type: string;

  @ApiProperty()
  confidence_score: number;

  @ApiProperty()
  reasoning_summary: string;

  @ApiProperty({ required: false })
  voice_confirmation?: string;
}

export class VoiceOutputDto {
  @ApiProperty({ type: [VoiceTransactionData] })
  transactions: VoiceTransactionData[];

  @ApiProperty({ required: false })
  overall_transcript?: string;
}
