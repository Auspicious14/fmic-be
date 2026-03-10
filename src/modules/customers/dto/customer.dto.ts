import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsArray,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCustomerDto {
  @ApiProperty({ example: 'Babatunde Adekunle' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'mechanic', required: false })
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiProperty({ example: ['Tunde', 'Babatunde'], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @ApiProperty({ example: '+2348012345678', required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ example: 'babatunde@example.com', required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ example: '12 Bode Thomas Street, Lagos', required: false })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ example: 'Frequent customer', required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateCustomerDto {
  @ApiProperty({ example: 'Babatunde Adekunle', required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ example: 'mechanic', required: false })
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiProperty({ example: ['Tunde', 'Babatunde'], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @ApiProperty({ example: '+2348012345678', required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ example: 'babatunde@example.com', required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ example: '12 Bode Thomas Street, Lagos', required: false })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ example: 'Frequent customer', required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class DeleteCustomerDto {
  @ApiProperty({ example: 'Customer moved away', required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
