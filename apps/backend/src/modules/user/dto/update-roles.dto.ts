import { ArrayNotEmpty, IsArray, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../schemas/user.schema';

export class UpdateRolesDto {
  @ApiProperty({
    enum: UserRole,
    isArray: true,
    example: [UserRole.ADMIN],
    description: 'Replaces the user\'s roles. Requires the "admin" role.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(UserRole, { each: true })
  roles!: UserRole[];
}
