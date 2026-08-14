import {
  IsString,
  IsEmail,
  IsOptional,
  IsInt,
  Min,
  Max,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({ example: 'John Doe' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'password123', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiPropertyOptional({ example: 25 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  age?: number;

  @ApiPropertyOptional({
    description:
      'Unique caller-supplied key — duplicate requests within 24 h return the original response',
  })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
