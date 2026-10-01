import type { MessageInitShape } from '@bufbuild/protobuf';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { decodeOffsetPageToken, encodeOffsetPageToken } from '@tropis/shared';
import { Audited } from '../../../common/audit/audited.decorator';
import { Authorize } from '../../../common/authz/authorize.decorator';
import { AppError } from '../../../common/errors';
import { USER_RESOURCE } from '../constants/user.constants';
import { UserSearchService } from '../services/user-search.service';
import { UserService } from '../services/user.service';
import { IUserResponse } from '../interfaces/user.interface';
import { UserRole, UserStatus } from '../constants/user.enums';
import { UpdateUserDto } from '../dto/update-user.dto';
import { ReplaceUserDto } from '../dto/replace-user.dto';
import { RpcService } from '../../../infrastructure/rpc/rpc-service.decorator';
import { RpcValidate } from '../../../infrastructure/rpc/rpc-validate.decorator';
import {
  CreateUserRpcDto,
  DeleteUserRpcDto,
  FindAllRpcDto,
  FindByIdRpcDto,
  FindSimilarRpcDto,
  ReplaceUserRpcDto,
  SearchUsersRpcDto,
  UpdateUserRpcDto,
} from '../dto/user-rpc.dto';
import {
  RpcAuthzService,
  rpcClientAddress,
  type RpcCaller,
} from '../../../infrastructure/rpc/rpc-authz.service';
import {
  UserService as UserServiceDesc,
  type CreateUserRequest,
  type DeleteUserRequest,
  type EmptyRequest,
  type FindAllRequest,
  type FindByIdRequest,
  type FindSimilarRequest,
  type ReplaceUserRequest,
  type SearchUsersRequest,
  type UpdateUserRequest,
  type UserResponseSchema,
  type UsersResponseSchema,
} from '../../../gen/user/v1/user_pb';

type UserResponse = MessageInitShape<typeof UserResponseSchema>;
type UsersResponse = MessageInitShape<typeof UsersResponseSchema>;

function toRpcUser(u: IUserResponse): UserResponse {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    age: u.age ?? 0,
    status: u.status,
    loginCount: u.loginCount,
  };
}

/**
 * Implements tropis.user.v1.UserService (proto/user/v1/user.proto).
 *
 * Every method except Create requires a valid JWT in the `authorization`
 * header and the `user` permission its @Authorize names; methods that act on
 * one record also require owner-or-admin. Create is self sign-up without a token (gated by the
 * tenant's self sign-up flag and rate limits), and an admin create with one.
 *
 * Try it (from the repo root, with the backend running):
 *   grpcurl -plaintext \
 *     -d '{"name":"Alice","email":"alice@example.com","password":"password123"}' \
 *     localhost:50051 tropis.user.v1.UserService/Create
 */
@RpcService(UserServiceDesc)
export class UserRpcController implements ServiceImpl<typeof UserServiceDesc> {
  constructor(
    private readonly userService: UserService,
    private readonly userSearch: UserSearchService,
    private readonly authz: RpcAuthzService,
  ) {}

  /**
   * Record ownership on top of the role permission @Authorize checked.
   *
   * The policy answers "may this role perform this action?", never "on whose
   * record?". `editor` holds `update`, so a role-only check would let any
   * signed-in user modify anyone, including resetting an admin's password.
   */
  private assertCanActOn(ctx: HandlerContext, targetUserId: string): RpcCaller {
    const caller = this.authz.caller(ctx);
    if (!caller.roles.includes(UserRole.ADMIN) && caller.sub !== targetUserId) {
      throw new AppError('FORBIDDEN', {
        detail: 'You may only modify your own account',
      });
    }
    return caller;
  }

  private static assertMayWriteStatus(caller: RpcCaller): void {
    if (!caller.roles.includes(UserRole.ADMIN)) {
      throw new AppError('FORBIDDEN', {
        detail: 'Only an admin can change account status',
      });
    }
  }

  /**
   * With a token whose roles hold `user:create`, creates the user in the
   * caller's tenant; otherwise it is self sign-up in the X-Tenant-ID tenant.
   */
  @Audited('user.create')
  @RpcValidate(CreateUserRpcDto)
  async create(
    req: CreateUserRequest,
    ctx: HandlerContext,
  ): Promise<UserResponse> {
    const dto = {
      name: req.name,
      email: req.email,
      password: req.password,
      age: req.age || undefined,
      idempotencyKey: req.idempotencyKey || undefined,
    };
    const caller = this.authz.optionalCaller(ctx);
    const user =
      caller && (await this.authz.allows(caller, USER_RESOURCE, 'create'))
        ? await this.userService.create(dto, `user:${caller.sub}`)
        : await this.userService.signUp(dto, rpcClientAddress(ctx));
    return toRpcUser(user);
  }

  // `list`, not `read`: enumeration is admin-only (see infra/opa/authz.rego).
  @Authorize(USER_RESOURCE, 'list')
  @RpcValidate(FindAllRpcDto)
  async findAll(req: FindAllRequest): Promise<UsersResponse> {
    // AIP-158 fields win; page/limit are the deprecated form of the same.
    const aip = req.pageSize > 0 || req.pageToken !== '';
    const limit = RpcAuthzService.clampLimit(
      aip ? req.pageSize : req.limit,
      20,
      100,
    );
    const offset = decodeOffsetPageToken(req.pageToken);
    if (offset === undefined) {
      throw AppError.validation([
        { field: 'page_token', description: 'page_token is not valid' },
      ]);
    }
    const result = await this.userService.findAll(
      aip ? Math.floor(offset / limit) + 1 : req.page || 1,
      limit,
    );
    return {
      users: result.data.map(toRpcUser),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      totalSize: result.total,
      nextPageToken:
        result.page < result.totalPages
          ? encodeOffsetPageToken(result.page * result.limit)
          : '',
    };
  }

  // Owner-or-admin: `read` alone would let any signed-in user pull an
  // arbitrary record (including its email) by id.
  @Authorize(USER_RESOURCE, 'read')
  @RpcValidate(FindByIdRpcDto)
  async findById(
    req: FindByIdRequest,
    ctx: HandlerContext,
  ): Promise<UserResponse> {
    this.assertCanActOn(ctx, req.id);
    return toRpcUser(await this.userService.findById(req.id));
  }

  @Authorize(USER_RESOURCE, 'read')
  async getMe(_req: EmptyRequest, ctx: HandlerContext): Promise<UserResponse> {
    const caller = this.authz.caller(ctx);
    return toRpcUser(await this.userService.findById(caller.sub));
  }

  @Audited('user.update')
  @Authorize(USER_RESOURCE, 'update')
  @RpcValidate(UpdateUserRpcDto)
  async update(
    req: UpdateUserRequest,
    ctx: HandlerContext,
  ): Promise<UserResponse> {
    const caller = this.assertCanActOn(ctx, req.id);
    const dto = new UpdateUserDto();
    if (req.name) dto.name = req.name;
    if (req.email) dto.email = req.email;
    if (req.password) dto.password = req.password;
    if (req.age) dto.age = req.age;
    // status is an access-control field (a suspended user cannot log in), so
    // only an admin may write it; otherwise anyone could lift their own
    // suspension by updating themselves back to active.
    if (req.status) {
      UserRpcController.assertMayWriteStatus(caller);
      dto.status = req.status as UserStatus;
    }
    return toRpcUser(
      await this.userService.update(req.id, dto, {
        userId: caller.sub,
        currentPassword: req.currentPassword || undefined,
      }),
    );
  }

  @Audited('user.replace')
  @Authorize(USER_RESOURCE, 'update')
  @RpcValidate(ReplaceUserRpcDto)
  async replace(
    req: ReplaceUserRequest,
    ctx: HandlerContext,
  ): Promise<UserResponse> {
    // ReplaceUserRpcDto requires a known status: proto3 sends an omitted
    // string as '', which would drop the user out of every status filter.
    const caller = this.assertCanActOn(ctx, req.id);
    const dto = new ReplaceUserDto();
    dto.name = req.name;
    dto.email = req.email;
    // Replace always carries a status, so a non-admin may only restate the one
    // the record already has.
    const current = await this.userService.findById(req.id);
    if ((req.status as UserStatus) !== current.status) {
      UserRpcController.assertMayWriteStatus(caller);
    }
    dto.status = req.status as UserStatus;
    if (req.password) dto.password = req.password;
    if (req.age) dto.age = req.age;
    return toRpcUser(
      await this.userService.update(req.id, dto, {
        userId: caller.sub,
        currentPassword: req.currentPassword || undefined,
      }),
    );
  }

  // Deliberately admin-only (the policy grants `delete` to admin alone): a
  // user cannot delete their own account through this RPC.
  @Audited('user.delete')
  @Authorize(USER_RESOURCE, 'delete')
  @RpcValidate(DeleteUserRpcDto)
  async delete(req: DeleteUserRequest): Promise<{ success: boolean }> {
    await this.userService.delete(req.id);
    return { success: true };
  }

  @Authorize(USER_RESOURCE, 'list')
  @RpcValidate(SearchUsersRpcDto)
  async search(req: SearchUsersRequest): Promise<UsersResponse> {
    const users = await this.userSearch.search(
      req.query,
      RpcAuthzService.clampLimit(req.pageSize || req.size, 10, 50),
    );
    return flatPage(users);
  }

  @Authorize(USER_RESOURCE, 'list')
  @RpcValidate(FindSimilarRpcDto)
  async findSimilar(req: FindSimilarRequest): Promise<UsersResponse> {
    const users = await this.userSearch.findSimilar(
      req.userId,
      RpcAuthzService.clampLimit(req.pageSize || req.limit, 5, 50),
    );
    return flatPage(users);
  }
}

/** A single unpaginated page, as Search and FindSimilar return. */
function flatPage(users: IUserResponse[]): UsersResponse {
  return {
    users: users.map(toRpcUser),
    total: users.length,
    page: 1,
    limit: users.length,
    totalPages: 1,
    totalSize: users.length,
    nextPageToken: '',
  };
}
