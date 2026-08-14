import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  TRACKING_MAX_BATCH,
  TRACKING_MAX_FIELD_LEN,
} from '../constants/tracking.constants';

export class TrackEventDto {
  @ApiProperty({ example: 'c0ffee00-0000-4000-8000-000000000001' })
  @IsString()
  @MaxLength(64)
  eventId: string;

  @ApiProperty({ example: 'button_click' })
  @IsString()
  @MaxLength(128)
  eventName: string;

  @ApiProperty({ example: '0b7c9d0e-...' })
  @IsString()
  @MaxLength(64)
  anonymousId: string;

  @ApiPropertyOptional({ example: 'user_123' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  sessionId: string;

  @ApiProperty({ example: '/behavior' })
  @IsString()
  @MaxLength(TRACKING_MAX_FIELD_LEN)
  page: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(TRACKING_MAX_FIELD_LEN)
  referrer?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(TRACKING_MAX_FIELD_LEN)
  userAgent?: string;

  @ApiPropertyOptional({ example: '1920x1080' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  screen?: string;

  @ApiPropertyOptional({ example: { label: 'Fire Event' } })
  @IsOptional()
  @IsObject()
  props?: Record<string, unknown>;

  @ApiProperty({ example: 1735689600000, description: 'Client epoch ms' })
  @IsNumber()
  timestamp: number;
}

export class TrackBatchDto {
  @ApiProperty({ type: [TrackEventDto], maxItems: TRACKING_MAX_BATCH })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TRACKING_MAX_BATCH)
  @ValidateNested({ each: true })
  @Type(() => TrackEventDto)
  events: TrackEventDto[];
}
