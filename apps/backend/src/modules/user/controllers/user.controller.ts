import {
  Controller,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UploadedFile,
  UseInterceptors,
  Get,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiConsumes,
  ApiOperation,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Audited } from '../../../common/audit/audited.decorator';
import { Authorize } from '../../../common/authz/authorize.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AppError } from '../../../common/errors';
import { USER_RESOURCE } from '../constants/user.constants';
import { UserRole } from '../constants/user.enums';
import { ListRolesQueryDto } from '../dto/list-roles-query.dto';
import { UpdateRolesDto } from '../dto/update-roles.dto';
import type { UserRolesPage } from '../interfaces/user.interface';
import {
  UserAvatarService,
  type AvatarActor,
  type AvatarFile,
  type AvatarUrl,
} from '../services/user-avatar.service';
import { UserService } from '../services/user.service';

/** Largest avatar upload accepted. */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** Client-declared types worth reading; anything else is refused unread. */
const AVATAR_CLAIMED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/octet-stream',
]);

/**
 * REST endpoints for what RPC cannot carry: multipart avatar uploads and
 * the role table of the Users page. Every route requires a JWT (the global
 * guard); role changes require `user:manage_roles`.
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly avatars: UserAvatarService,
  ) {}

  /**
   * GET /api/users/roles?pageSize=&pageToken= — one page of user ids with
   * their roles (AIP-158). Admin-only: it identifies which accounts hold admin.
   */
  @Get('roles')
  @Authorize(USER_RESOURCE, 'manage_roles')
  @ApiOperation({ summary: 'Roles of the tenant users, paged (admin only)' })
  listRoles(@Query() query: ListRolesQueryDto): Promise<UserRolesPage> {
    return this.userService.listRoles(query.pageSize, query.pageToken);
  }

  /** PATCH /api/users/:id/roles — replaces a user's roles (admin only). */
  @Patch(':id/roles')
  @Audited('user.manage_roles')
  @Authorize(USER_RESOURCE, 'manage_roles')
  @ApiOperation({ summary: 'Replace a user’s roles (admin only)' })
  async updateRoles(
    @Param('id') id: string,
    @Body() dto: UpdateRolesDto,
  ): Promise<{ id: string; roles: UserRole[] }> {
    const roles = await this.userService.updateRoles(id, dto.roles);
    return { id, roles };
  }

  /** POST /api/users/:id/avatar — uploads a profile picture; returns a URL valid for 1 hour. */
  @Post(':id/avatar')
  @Audited('user.avatar.upload')
  @ApiOperation({ summary: 'Upload user avatar (multipart/form-data)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: AVATAR_MAX_BYTES },
      // The content type is decided from the bytes (UserAvatarService);
      // the client's mimetype is only a first filter.
      fileFilter: (_, file, cb) => {
        if (!AVATAR_CLAIMED_TYPES.has(file.mimetype)) {
          return cb(
            AppError.validation([
              {
                field: 'file',
                description: 'The file must be a PNG, JPEG, GIF or WebP image',
              },
            ]),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  uploadAvatar(
    @Param('id') userId: string,
    @CurrentUser() actor: AvatarActor,
    @UploadedFile() file: AvatarFile,
  ): Promise<AvatarUrl> {
    return this.avatars.upload(userId, actor, file);
  }

  /** GET /api/users/:id/avatar-url?key=avatars/<userId>/<file> — a fresh presigned URL. */
  @Get(':id/avatar-url')
  @ApiOperation({
    summary: 'Get a fresh pre-signed URL for an existing avatar',
  })
  getAvatarUrl(
    @Param('id') userId: string,
    @CurrentUser() actor: AvatarActor,
    @Query('key') objectName: string,
  ): Promise<AvatarUrl> {
    return this.avatars.url(userId, actor, objectName);
  }
}
