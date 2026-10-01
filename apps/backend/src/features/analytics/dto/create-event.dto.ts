import { IsIn, IsString, IsObject, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ANALYTICS_EVENT_TYPES, type AnalyticsEventType } from '@tropis/shared';

const EVENT_TYPE_VALUES = Object.values(ANALYTICS_EVENT_TYPES);

export class CreateEventDto {
  @ApiProperty({
    enum: EVENT_TYPE_VALUES,
    example: ANALYTICS_EVENT_TYPES.PAGE_VIEW,
  })
  @IsIn(EVENT_TYPE_VALUES)
  eventType: AnalyticsEventType;

  @ApiProperty({ example: 'user_123' })
  @IsString()
  userId: string;

  @ApiPropertyOptional({ example: { page: '/home', duration: 1200 } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
