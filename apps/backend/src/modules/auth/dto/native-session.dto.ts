import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class NativeRefreshDto {
  @ApiProperty({ description: 'The refresh token from OS secure storage' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  refreshToken!: string;
}

export class NativeLogoutDto {
  @ApiPropertyOptional({ description: 'The refresh token to revoke' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  refreshToken?: string;
}
