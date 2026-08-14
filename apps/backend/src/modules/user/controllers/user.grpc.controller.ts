import { Controller } from '@nestjs/common';
import { Audited } from '../../../common/decorators/audited.decorator';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { UserService } from '../services/user.service';
import { IUserResponse } from '../interfaces/user.interface';
import { UserRole, UserStatus } from '../schemas/user.schema';
import { UpdateUserDto } from '../dto/update-user.dto';
import { ReplaceUserDto } from '../dto/replace-user.dto';
import { OpaService } from '../../../infrastructure/opa/opa.service';
import { extractToken } from '../../../infrastructure/grpc/grpc.utils';

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
  private readonly jwtSecret: string;

  constructor(
    private readonly userService: UserService,
    private readonly config: ConfigService,
    private readonly opaService: OpaService,
  ) {
    this.jwtSecret = this.config.getOrThrow<string>('JWT_SECRET');
  }

  private verifyToken(token: string): {
    sub: string;
    email: string;
    roles?: UserRole[];
  } {
    try {
      return jwt.verify(token, this.jwtSecret) as {
        sub: string;
        email: string;
        roles?: UserRole[];
      };
    } catch {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Invalid or expired token',
      });
    }
  }

  private async assertOpa(token: string, action: string): Promise<void> {
    const payload = this.verifyToken(token);
    const allowed = await this.opaService.allow({
      roles: payload.roles ?? [],
      resource: 'user',
      action,
    });
    if (!allowed)
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: `Permission denied: ${action} on user`,
      });
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
  async findAll(data: FindAllRequest): Promise<UsersResponse> {
    const result = await this.userService.findAll(
      data.page ?? 1,
      data.limit ?? 20,
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
  async findById(data: FindByIdRequest): Promise<UserResponse> {
    const user = await this.userService.findById(data.id);
    return toGrpcUser(user);
  }

  @GrpcMethod('UserService', 'GetMe')
  async getMe(data: TokenRequest, metadata: unknown): Promise<UserResponse> {
    const token = extractToken(data, metadata);
    await this.assertOpa(token, 'read');
    const payload = this.verifyToken(token);
    const user = await this.userService.findById(payload.sub);
    return toGrpcUser(user);
  }

  @Audited('user.update')
  @GrpcMethod('UserService', 'Update')
  async update(
    data: UpdateUserRequest,
    metadata: unknown,
  ): Promise<UserResponse> {
    const token = extractToken(data, metadata);
    await this.assertOpa(token, 'update');
    const dto = new UpdateUserDto();
    if (data.name) dto.name = data.name;
    if (data.email) dto.email = data.email;
    if (data.password) dto.password = data.password;
    if (data.age) dto.age = data.age;
    if (data.status) dto.status = data.status as UserStatus;
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
    await this.assertOpa(token, 'update');
    const dto = new ReplaceUserDto();
    dto.name = data.name;
    dto.email = data.email;
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
    const token = extractToken(data, metadata);
    await this.assertOpa(token, 'delete');
    await this.userService.delete(data.id);
    return { success: true };
  }

  @GrpcMethod('UserService', 'Search')
  async search(data: SearchUsersRequest): Promise<UsersResponse> {
    const users = await this.userService.search(data.query, data.size || 10);
    return {
      users: users.map(toGrpcUser),
      total: users.length,
      page: 1,
      limit: users.length,
      total_pages: 1,
    };
  }

  @GrpcMethod('UserService', 'FindSimilar')
  async findSimilar(data: FindSimilarRequest): Promise<UsersResponse> {
    const users = await this.userService.findSimilar(
      data.user_id,
      data.limit || 5,
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
