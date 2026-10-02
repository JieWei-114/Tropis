import { UserDocument } from '../schemas/user.schema';
import { IUserResponse, IUserWithPassword } from '../interfaces/user.interface';

export class UserTransformer {
  static toResponse(user: UserDocument): IUserResponse {
    return {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      age: user.age,
      status: user.status,
      roles: user.roles ?? [],
      loginCount: user.loginCount,
      ...isoField('createdAt', user.createdAt),
      ...isoField('updatedAt', user.updatedAt),
    };
  }

  static toResponseList(users: UserDocument[]): IUserResponse[] {
    return users.map((user) => UserTransformer.toResponse(user));
  }

  // Used only by AuthService — includes passwordHash for verification
  static toWithPassword(user: UserDocument): IUserWithPassword {
    return {
      ...UserTransformer.toResponse(user),
      passwordHash: user.passwordHash,
      tenantId: user.tenantId,
      tokenVersion: user.tokenVersion ?? 0,
    };
  }
}

function isoField<K extends string>(
  key: K,
  value: Date | undefined,
): Partial<Record<K, string>> {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? ({ [key]: value.toISOString() } as Record<K, string>)
    : {};
}
