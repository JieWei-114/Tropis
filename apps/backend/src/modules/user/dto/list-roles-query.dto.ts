import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ListRolesQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 20,
    description: 'Clamped to 100',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pageSize?: number;

  @ApiPropertyOptional({
    description: 'The nextPageToken of the previous page',
  })
  @IsOptional()
  @IsString()
  pageToken?: string;
}
