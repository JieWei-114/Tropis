import { UserRole, UserStatus } from '../schemas/user.schema';

export interface IUserResponse {
  id: string;
  name: string;
  email: string;
  age?: number;
  status: UserStatus;
  roles: UserRole[];
  loginCount: number;
}

// Used internally by AuthService only — never sent over the wire
export interface IUserWithPassword extends IUserResponse {
  passwordHash: string;
  tenantId: string;
}
