import {
  Controller,
  Post,
  Param,
  Query,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  ForbiddenException,
  BadRequestException,
  Get,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiConsumes,
  ApiOperation,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { extname, basename } from 'path';
import { Audited } from '../../../common/decorators/audited.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { StorageService } from '../../../infrastructure/storage/storage.service';
import { UserService } from '../services/user.service';

/** Shape of the authenticated principal attached by JwtStrategy.validate(). */
interface AuthUser {
  userId: string;
  roles: string[];
}

/** Allow the resource owner or an admin; reject everyone else. */
function assertCanActOn(targetUserId: string, actor: AuthUser): void {
  if (actor.userId !== targetUserId && !actor.roles?.includes('admin')) {
    throw new ForbiddenException('You may only manage your own avatar');
  }
}

const ALLOWED_IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.avif',
]);

/** Strip everything except the bare extension and validate it against the allowlist. */
function safeImageExt(originalname: string): string {
  const ext = extname(basename(originalname)).toLowerCase();
  return ALLOWED_IMAGE_EXTS.has(ext) ? ext.slice(1) : 'jpg';
}

/**
 * REST endpoints for file operations — kept separate from gRPC because
 * multipart/form-data binary uploads don't map cleanly to protobuf messages.
 *
 * All business logic (CRUD, auth) stays in gRPC; only file I/O is REST.
 */
@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard) // require a valid JWT for every file endpoint below
@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly storageService: StorageService,
  ) {}

  /**
   * POST /api/users/:id/avatar
   * Upload a profile picture for a user.
   * Returns a pre-signed URL valid for 1 hour.
   */
  @Post(':id/avatar')
  @Audited('user.avatar.upload')
  @ApiOperation({ summary: 'Upload user avatar (multipart/form-data)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
      fileFilter: (_, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          return cb(
            new BadRequestException('Only image files are allowed'),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  async uploadAvatar(
    @Param('id') userId: string,
    @CurrentUser() actor: AuthUser,
    @UploadedFile()
    file: {
      buffer: Buffer;
      originalname: string;
      size: number;
      mimetype: string;
    },
  ) {
    assertCanActOn(userId, actor); // owner or admin only — prevents cross-user IDOR
    if (!file) throw new BadRequestException('No file provided');

    const ext = safeImageExt(file.originalname);
    // Object key is fully server-generated — no user-supplied path segments.
    // randomUUID() ensures no collisions and no path traversal surface.
    const objectName = `avatars/${userId}/${randomUUID()}.${ext}`;

    await this.storageService.upload(
      objectName,
      file.buffer,
      file.size,
      file.mimetype,
    );

    const url = await this.storageService.getSignedUrl(objectName, 3600);
    return { url, objectName };
  }

  /**
   * GET /api/users/:id/avatar-url?key=avatars/<userId>/<file>
   * Refresh a pre-signed URL for an existing avatar object.
   */
  @Get(':id/avatar-url')
  @ApiOperation({
    summary: 'Get a fresh pre-signed URL for an existing avatar',
  })
  async getAvatarUrl(
    @Param('id') userId: string,
    @CurrentUser() actor: AuthUser,
    @Query('key') objectName: string,
  ) {
    assertCanActOn(userId, actor); // owner or admin only
    if (!objectName)
      throw new BadRequestException('Query param ?key= is required');

    // Prevent path traversal: the object key must be scoped to this user's avatar prefix.
    const expectedPrefix = `avatars/${userId}/`;
    if (!objectName.startsWith(expectedPrefix) || objectName.includes('..')) {
      throw new BadRequestException('Invalid object key');
    }

    const url = await this.storageService.getSignedUrl(objectName, 3600);
    return { url, objectName };
  }
}
