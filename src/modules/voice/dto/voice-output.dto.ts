import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export enum VoiceIntent {
  CREDIT_SALE = 'CREDIT_SALE',
  PAYMENT = 'PAYMENT',
  ADJUSTMENT = 'ADJUSTMENT',
  PRODUCT_PRICE_UPDATE = 'PRODUCT_PRICE_UPDATE',
  DAILY_SUMMARY = 'DAILY_SUMMARY',
  UNKNOWN = 'UNKNOWN',
  UNCLEAR = 'UNCLEAR',
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

  @ApiProperty({ required: false, description: 'What the customer owed before this entry (known customers only)' })
  current_balance?: number;

  @ApiProperty({ required: false, description: 'What the customer will owe after this entry' })
  balance_after?: number;

  @ApiProperty({ required: false, description: 'Amount the trader said is still owed, if they said one' })
  stated_remaining?: number;

  @ApiProperty({ required: false, type: [String], description: 'Things the trader should check before saving' })
  warnings?: string[];

  @ApiProperty({ required: false, description: 'Credit sale heard without any price; must not be saved at ₦0' })
  needs_price?: boolean;
}

export class VoiceOutputDto {
  @ApiProperty({ example: 'yo' })
  @IsOptional()
  @IsString()
  detectedLanguage?: 'yo' | 'en' | 'pcm' | 'mixed';

  @IsOptional()
  @IsString()
  @ApiProperty({ example: 'credit' })
  confirmationAudio?: string | null;

  @ApiProperty({ type: [VoiceTransactionData] })
  transactions: VoiceTransactionData[];

  @ApiProperty({ required: false })
  overall_transcript?: string;

  @ApiProperty({ required: false })
  transcriptionCandidates?: Array<{
    text: string;
    language: 'yo' | 'en' | 'pcm';
    confidence: number;
    score?: number;
  }>;
}
