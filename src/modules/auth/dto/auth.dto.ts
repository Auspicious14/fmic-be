import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'owner@shop.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'password123', minLength: 6 })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({ example: 'Chidi Okafor' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Chidi Provisions Shop' })
  @IsString()
  @IsNotEmpty()
  shopName: string;
}

export class LoginDto {
  @ApiProperty({ example: 'owner@shop.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @IsNotEmpty()
  password: string;
}
