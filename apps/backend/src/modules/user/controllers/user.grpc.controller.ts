import { Controller } from '@nestjs/common';
import { Audited } from '../../../common/decorators/audited.decorator';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { UserService } from '../services/user.service';
import { IUserResponse } from '../interfaces/user.interface';
import { UserRole, UserStatus } from '../constants/user.enums';
import { UpdateUserDto } from '../dto/update-user.dto';
import { ReplaceUserDto } from '../dto/replace-user.dto';
import { extractToken } from '../../../infrastructure/grpc/grpc.utils';
import {
  GrpcAuthzService,
  type GrpcCaller,
} from '../../../infrastructure/grpc/grpc-authz.service';

interface CreateUserRequest {
  name: string;
  email: string;
  password: string;
  age?: number;
  idempotency_key?: string;
}
interface FindAllRequest {
  page?: number;
  limit?: number;
}
interface FindByIdRequest {
  id: string;
}
interface TokenRequest {
  token?: string;
}
interface UpdateUserRequest {
  id: string;
  name?: string;
  email?: string;
  password?: string;
  age?: number;
  status?: string;
}
interface ReplaceUserRequest {
  id: string;
  name: string;
  email: string;
  status: string;
  password?: string;
  age?: number;
}
interface DeleteUserRequest {
  id: string;
}
interface SearchUsersRequest {
  query: string;
  size?: number;
}
interface FindSimilarRequest {
  user_id: string;
  limit?: number;
}

interface UserResponse {
  id: string;
  name: string;
  email: string;
  age: number;
  status: string;
  login_count: number;
}
interface UsersResponse {
  users: UserResponse[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}
interface DeleteResponse {
  success: boolean;
}

function toGrpcUser(u: IUserResponse): UserResponse {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    age: u.age ?? 0,
    status: u.status,
    login_count: u.loginCount,
  };
}

/**
 * Implements the UserService defined in proto/user/v1/user.proto.
 *
 * Protected methods (GetMe, Update, Replace, Delete) require a valid JWT
 * passed in the gRPC Authorization metadata header.
 *
 * Test with grpcurl (from repo root):
 *   grpcurl -plaintext -import-path apps/backend -proto proto/user/v1/user.proto \
 *     -d '{"name":"Alice","email":"alice@example.com","password":"password123"}' \
 *     localhost:50051 tropis.user.v1.UserService/Create
 */
@Controller()
export class GrpcUserService {
  constructor(
    private readonly userService: UserService,
    private readonly authz: GrpcAuthzService,
  ) {}

  private assertOpa(token: string, action: string): Promise<GrpcCaller> {
    return this.authz.assert(token, 'user', action);
  }

  /**
   * Role permission PLUS record ownership.
   *
   * OPA answers "may this role perform this action?" — never "on whose record?".
   * `editor` holds `update`, so a role-only check let any signed-in user modify
   * anyone, including resetting an admin's password. Owner-or-admin closes that.
   */
  private async assertCanActOn(
    token: string,
    targetUserId: string,
    action: string,
  ): Promise<GrpcCaller> {
    const caller = await this.assertOpa(token, action);
    if (!caller.roles.includes(UserRole.ADMIN) && caller.sub !== targetUserId) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'You may only modify your own account',
      });
    }
    return caller;
  }

  private static assertMayWriteStatus(caller: GrpcCaller): void {
    if (!caller.roles.includes(UserRole.ADMIN)) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'Only an admin can change account status',
      });
    }
  }

  @Audited('user.create')
  @GrpcMethod('UserService', 'Create')
  async create(data: CreateUserRequest): Promise<UserResponse> {
    const user = await this.userService.create({
      name: data.name,
      email: data.email,
      password: data.password,
      age: data.age || undefined,
      idempotencyKey: data.idempotency_key,
    });
    return toGrpcUser(user);
  }

  @GrpcMethod('UserService', 'FindAll')
  async findAll(
    data: FindAllRequest,
    metadata: unknown,
  ): Promise<UsersResponse> {
    // `list`, not `read`: enumeration is admin-only (see infra/opa/authz.rego).
    await this.assertOpa(extractToken(data, metadata), 'list');
    const result = await this.userService.findAll(
      data.page ?? 1,
      GrpcAuthzService.clampLimit(data.limit, 20, 100),
    );
    return {
      users: result.data.map(toGrpcUser),
      total: result.total,
      page: result.page,
      limit: result.limit,
      total_pages: result.totalPages,
    };
  }

  @GrpcMethod('UserService', 'FindById')
  async findById(
    data: FindByIdRequest,
    metadata: unknown,
  ): Promise<UserResponse> {
    // Owner-or-admin: `read` alone would let any signed-in user pull an
    // arbitrary record (including its email) by id.
    await this.assertCanActOn(extractToken(data, metadata), data.id, 'read');
    const user = await this.userService.findById(data.id);
    return toGrpcUser(user);
  }

  @GrpcMethod('UserService', 'GetMe')
  async getMe(data: TokenRequest, metadata: unknown): Promise<UserResponse> {
    const caller = await this.assertOpa(extractToken(data, metadata), 'read');
    const user = await this.userService.findById(caller.sub);
    return toGrpcUser(user);
  }

  @Audited('user.update')
  @GrpcMethod('UserService', 'Update')
  async update(
    data: UpdateUserRequest,
    metadata: unknown,
  ): Promise<UserResponse> {
    const token = extractToken(data, metadata);
    const caller = await this.assertCanActOn(token, data.id, 'update');
    const dto = new UpdateUserDto();
    if (data.name) dto.name = data.name;
    if (data.email) dto.email = data.email;
    if (data.password) dto.password = data.password;
    if (data.age) dto.age = data.age;
    // status is an access-control field (a suspended user cannot log in), so
    // only an admin may write it — otherwise anyone could lift their own
    // suspension by PATCHing themselves back to active.
    if (data.status) {
      GrpcUserService.assertMayWriteStatus(caller);
      dto.status = data.status as UserStatus;
    }
    const user = await this.userService.update(data.id, dto);
    return toGrpcUser(user);
  }

  @Audited('user.replace')
  @GrpcMethod('UserService', 'Replace')
  async replace(
    data: ReplaceUserRequest,
    metadata: unknown,
  ): Promise<UserResponse> {
    const token = extractToken(data, metadata);
    const caller = await this.assertCanActOn(token, data.id, 'update');
    // proto3 sends an omitted string as '', which would otherwise be written
    // verbatim and drop the user out of every status filter.
    if (!Object.values(UserStatus).includes(data.status as UserStatus)) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: `status must be one of: ${Object.values(UserStatus).join(', ')}`,
      });
    }
    const dto = new ReplaceUserDto();
    dto.name = data.name;
    dto.email = data.email;
    // Replace always carries a status, so a non-admin may only restate the one
    // the record already has.
    const current = await this.userService.findById(data.id);
    if ((data.status as UserStatus) !== current.status) {
      GrpcUserService.assertMayWriteStatus(caller);
    }
    dto.status = data.status as UserStatus;
    if (data.password) dto.password = data.password;
    if (data.age) dto.age = data.age;
    const user = await this.userService.update(data.id, dto);
    return toGrpcUser(user);
  }

  @Audited('user.delete')
  @GrpcMethod('UserService', 'Delete')
  async delete(
    data: DeleteUserRequest,
    metadata: unknown,
  ): Promise<DeleteResponse> {
    // Deliberately admin-only (OPA grants `delete` to admin alone) — a user
    // cannot delete their own account through this RPC.
    await this.assertOpa(extractToken(data, metadata), 'delete');
    await this.userService.delete(data.id);
    return { success: true };
  }

  @GrpcMethod('UserService', 'Search')
  async search(
    data: SearchUsersRequest,
    metadata: unknown,
  ): Promise<UsersResponse> {
    await this.assertOpa(extractToken(data, metadata), 'list');
    const users = await this.userService.search(
      data.query,
      GrpcAuthzService.clampLimit(data.size, 10, 50),
    );
    return {
      users: users.map(toGrpcUser),
      total: users.length,
      page: 1,
      limit: users.length,
      total_pages: 1,
    };
  }

  @GrpcMethod('UserService', 'FindSimilar')
  async findSimilar(
    data: FindSimilarRequest,
    metadata: unknown,
  ): Promise<UsersResponse> {
    await this.assertOpa(extractToken(data, metadata), 'list');
    const users = await this.userService.findSimilar(
      data.user_id,
      GrpcAuthzService.clampLimit(data.limit, 5, 50),
    );
    return {
      users: users.map(toGrpcUser),
      total: users.length,
      page: 1,
      limit: users.length,
      total_pages: 1,
    };
  }
}
