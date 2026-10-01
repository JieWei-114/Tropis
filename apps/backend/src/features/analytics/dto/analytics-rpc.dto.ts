import {
  IsIn,
  IsInt,
  IsString,
  MaxLength,
  Min,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';
import { ANALYTICS_EVENT_TYPES } from '@tropis/shared';
import { ProtoOptional } from '../../../infrastructure/rpc/rpc-validate.decorator';

const EVENT_TYPE_VALUES = Object.values(ANALYTICS_EVENT_TYPES);

/** Largest metadata document one event may carry, as JSON text. */
export const METADATA_MAX_LENGTH = 8 * 1024;

/** Upper bound on the minutely-stats window a single call may request. */
export const MAX_MINUTES = 24 * 60;

/** Parses JSON text that must hold an object; undefined otherwise. */
export function parseJsonObject(
  text: string,
): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function IsJsonObjectText(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isJsonObjectText',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && parseJsonObject(value) !== undefined,
        defaultMessage: () => 'metadata must be a JSON object',
      },
    },
    options,
  );
}

/** tropis.analytics.v1.AnalyticsService CreateEvent. */
export class CreateEventRpcDto {
  @IsIn(EVENT_TYPE_VALUES)
  eventType!: string;

  @IsString()
  @MaxLength(128)
  userId!: string;

  @ProtoOptional()
  @IsString()
  @MaxLength(METADATA_MAX_LENGTH)
  @IsJsonObjectText()
  metadata!: string;
}

/** tropis.analytics.v1.AnalyticsService GetMinutelyStats; clamped to MAX_MINUTES. */
export class MinutelyStatsRpcDto {
  @IsInt()
  @Min(0)
  minutes!: number;
}
