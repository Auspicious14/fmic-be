import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsEnum,
  IsArray,
  ValidateNested,
  IsOptional,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { TransactionType } from '../schemas/transaction.schema';

class CreateTransactionItemDto {
  @ApiProperty({ example: 'Indomie Onion Flavor' })
  @IsString()
  @IsNotEmpty()
  productName: string;

  @ApiProperty({ example: '65f1234567890abcdef12345', required: false })
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiProperty({ example: 2 })
  @IsNumber()
  @Min(1)
  quantity: number;

  @ApiProperty({ example: 150 })
  @IsNumber()
  @Min(0)
  unitPriceAtSale: number;
}

export class CreateTransactionDto {
  @ApiProperty({ example: '65f1234567890abcdef12345' })
  @IsString()
  @IsNotEmpty()
  customerId: string;

  @ApiProperty({ type: [CreateTransactionItemDto] })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateTransactionItemDto)
  items: CreateTransactionItemDto[];

  @ApiProperty({ example: 1000, required: false, description: 'Direct amount for payments or non-itemized transactions' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @ApiProperty({ enum: TransactionType })
  @IsEnum(TransactionType)
  type: TransactionType;

  @ApiProperty({ example: 'Customer bought 2 Indomie packets on credit' })
  @IsOptional()
  @IsString()
  voiceTranscript?: string;

  @ApiProperty({ example: 'unique-uuid-per-request' })
  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;

  @ApiProperty({ example: 'device-unique-id', required: false })
  @IsOptional()
  @IsString()
  deviceId?: string;
}

export class CreateAdjustmentDto {
  @ApiProperty({ example: '65f1234567890abcdef12345' })
  @IsString()
  @IsNotEmpty()
  customerId: string;

  @ApiProperty({
    example: -50,
    description: 'Negative for correction, positive for addition',
  })
  @IsNumber()
  amount: number;

  @ApiProperty({ example: 'Correcting double entry' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiProperty({ example: 'unique-uuid-per-request' })
  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}
