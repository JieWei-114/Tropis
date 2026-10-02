import { UserRole, UserStatus } from '../schemas/user.schema';

export interface IUserResponse {
  id: string;
  name: string;
  email: string;
  age?: number;
  status: UserStatus;
  roles: UserRole[];
  loginCount: number;
  /** ISO 8601 UTC. */
  createdAt?: string;
  updatedAt?: string;
}

// Used internally by AuthService only — never sent over the wire
export interface IUserWithPassword extends IUserResponse {
  passwordHash: string;
  tenantId: string;
  /** Bumped on a password, email, role or status change; older tokens stop working. */
  tokenVersion: number;
}

export interface UserRolesPage {
  items: { userId: string; roles: string[] }[];
  /** Empty on the last page. */
  nextPageToken: string;
  totalSize: number;
}
