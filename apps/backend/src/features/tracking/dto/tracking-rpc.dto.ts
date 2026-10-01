import { IsInt, Max, Min } from 'class-validator';

/** tropis.tracking.v1.TrackingService GetInsights; 0 means the default window. */
export class InsightsRpcDto {
  @IsInt()
  @Min(0)
  @Max(366)
  days!: number;
}
