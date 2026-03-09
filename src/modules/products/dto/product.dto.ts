import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProductDto {
  @ApiProperty({ example: 'Indomie Onion Flavor' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 150 })
  @IsNumber()
  @Min(0)
  unitPrice: number;

  @ApiProperty({ example: 4500, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  bulkPrice?: number;
}

export class UpdatePriceDto {
  @ApiProperty({ example: 160 })
  @IsNumber()
  @Min(0)
  unitPrice: number;

  @ApiProperty({ example: 4800, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  bulkPrice?: number;
}
