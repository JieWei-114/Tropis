import {
  IsString,
  IsEmail,
  IsOptional,
  IsInt,
  Min,
  Max,
  MinLength,
  IsEnum,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '../schemas/user.schema';

/** PUT — all fields required (full replacement). Use PATCH for partial updates. */
export class ReplaceUserDto {
  @ApiProperty({ example: 'John Doe' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ example: 'newpassword123', minLength: 8 })
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @ApiPropertyOptional({ example: 25 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  age?: number;

  @ApiProperty({ enum: UserStatus, example: UserStatus.ACTIVE })
  @IsEnum(UserStatus)
  status: UserStatus;
}
