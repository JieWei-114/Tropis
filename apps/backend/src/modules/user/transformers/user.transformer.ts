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
    };
  }

  static toResponseList(users: UserDocument[]): IUserResponse[] {
    return users.map(UserTransformer.toResponse);
  }

  // Used only by AuthService — includes passwordHash for verification
  static toWithPassword(user: UserDocument): IUserWithPassword {
    return {
      ...UserTransformer.toResponse(user),
      passwordHash: (user as any).passwordHash as string,
      tenantId: user.tenantId,
    };
  }
}
