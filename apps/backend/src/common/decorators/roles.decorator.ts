import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../modules/user/schemas/user.schema';

export const ROLES_KEY = 'roles';

/** Restrict a route/gRPC method to one or more roles. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
