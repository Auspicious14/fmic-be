import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ProcessVoiceDto {
  @ApiProperty({ example: 'Babatunde bought 2 Indomie on credit' })
  @IsString()
  @IsNotEmpty()
  transcript: string;

  @ApiProperty({ example: 'device-123', required: false })
  @IsOptional()
  @IsString()
  deviceId?: string;
}

export class VoiceExtractionResponseDto {
  @ApiProperty({ example: 'Babatunde Adekunle' })
  customerName: string;

  @ApiProperty({ example: '65f1234567890abcdef12345', required: false })
  customerId?: string;

  @ApiProperty({
    example: [{ productName: 'Indomie', quantity: 2, unitPrice: 150 }],
  })
  items: Array<{
    productName: string;
    quantity: number;
    unitPrice?: number;
    productId?: string;
  }>;

  @ApiProperty({ example: 'credit' })
  transactionType: 'credit' | 'payment';

  @ApiProperty({ example: 0.95 })
  confidenceScore: number;

  @ApiProperty({ example: 'extracted successfully' })
  message: string;
}
