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
  IsUUID,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  TRACKING_MAX_BATCH,
  TRACKING_MAX_FIELD_LEN,
} from '../constants/tracking.constants';

/**
 * Lower bound for a client timestamp (2020-01-01 in epoch ms). Anything below
 * this is almost certainly seconds mistaken for milliseconds.
 */
const TIMESTAMP_MIN_MS = 1_577_836_800_000;

export class TrackEventDto {
  // Must be a UUID: the ClickHouse column is UUID, and JSONEachRow rejects the
  // WHOLE batch on a single malformed value. An SDK sending a nanoid would cost
  // up to TRACKING_MAX_BATCH events per message, after the client has already
  // been given its 202.
  @ApiProperty({ example: 'c0ffee00-0000-4000-8000-000000000001' })
  @IsUUID()
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

  // Range-checked because it is client-supplied and lands in DateTime64(3): an
  // SDK sending seconds rather than ms produces rows dated 1970, which every
  // `now() - INTERVAL n DAY` query ignores — accepted, stored, invisible.
  @ApiProperty({ example: 1735689600000, description: 'Client epoch ms' })
  @IsNumber()
  @Min(TIMESTAMP_MIN_MS)
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
