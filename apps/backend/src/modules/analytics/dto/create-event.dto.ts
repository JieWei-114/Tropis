import { IsEnum, IsString, IsObject, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AnalyticsEventType } from '../schemas/event-log.schema';

export class CreateEventDto {
  @ApiProperty({
    enum: AnalyticsEventType,
    example: AnalyticsEventType.PAGE_VIEW,
  })
  @IsEnum(AnalyticsEventType)
  eventType: AnalyticsEventType;

  @ApiProperty({ example: 'user_123' })
  @IsString()
  userId: string;

  @ApiPropertyOptional({ example: { page: '/home', duration: 1200 } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  tenantId?: string;
}
