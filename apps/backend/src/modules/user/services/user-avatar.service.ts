import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AppError } from '../../../common/errors';
import { TenantContext } from '../../../common/tenant/tenant.context';
import {
  OBJECTS,
  type ObjectsPort,
} from '../../../infrastructure/objects/objects.port';
import { UserRole } from '../constants/user.enums';
import { UserService } from './user.service';

/** Who acts on an avatar: the principal the JWT guard attached. */
export interface AvatarActor {
  userId: string;
  roles: string[];
}

export interface AvatarFile {
  buffer: Buffer;
  originalname: string;
  size: number;
  mimetype: string;
}

export interface AvatarUrl {
  url: string;
  objectName: string;
}

/** Lifetime of a presigned avatar URL. */
const AVATAR_URL_TTL_SECONDS = 3600;

interface ImageType {
  contentType: string;
  ext: string;
}

/**
 * The image types an avatar may have, recognised by their leading bytes.
 * SVG is deliberately absent: it is a document that can carry script.
 */
function detectImage(buf: Buffer): ImageType | undefined {
  const starts = (sig: readonly number[], at = 0) =>
    buf.length >= at + sig.length && sig.every((b, i) => buf[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: 'image/png', ext: 'png' };
  }
  if (starts([0xff, 0xd8, 0xff])) {
    return { contentType: 'image/jpeg', ext: 'jpg' };
  }
  if (
    starts([0x47, 0x49, 0x46, 0x38]) &&
    (buf[4] === 0x37 || buf[4] === 0x39)
  ) {
    return { contentType: 'image/gif', ext: 'gif' };
  }
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) {
    return { contentType: 'image/webp', ext: 'webp' };
  }
  return undefined;
}

/** Object key prefix of a user's avatars, inside the tenant's object space. */
const avatarPrefix = (userId: string) => `avatars/${userId}/`;

/** Served as a download when opened directly, never rendered as a page. */
const AVATAR_DISPOSITION = 'attachment; filename="avatar"';

/** User avatars in the objects capability, owner-or-admin only. */
@Injectable()
export class UserAvatarService {
  constructor(
    @Inject(OBJECTS) private readonly objects: ObjectsPort,
    private readonly users: UserService,
    private readonly tenantCtx: TenantContext,
  ) {}

  /** Stores the image under a server-generated key; returns a presigned URL. */
  async upload(
    userId: string,
    actor: AvatarActor,
    file: AvatarFile | undefined,
  ): Promise<AvatarUrl> {
    await this.assertCanManage(userId, actor);
    if (!file) {
      throw AppError.validation([
        { field: 'file', description: 'No file provided' },
      ]);
    }
    // The type comes from the bytes, never from the client's mimetype or
    // file name, so markup labelled as an image is refused.
    const image = detectImage(file.buffer);
    if (!image) {
      throw AppError.validation([
        {
          field: 'file',
          description: 'The file must be a PNG, JPEG, GIF or WebP image',
        },
      ]);
    }
    // Fully server-generated key: no user-supplied path segment.
    const objectName = `${avatarPrefix(userId)}${randomUUID()}.${image.ext}`;
    const tenant = this.tenantCtx.tenant;
    await this.objects.put(
      tenant,
      objectName,
      file.buffer,
      file.buffer.length,
      image.contentType,
    );
    const url = await this.objects.presignedGet(
      tenant,
      objectName,
      AVATAR_URL_TTL_SECONDS,
      { contentDisposition: AVATAR_DISPOSITION },
    );
    return { url, objectName };
  }

  /** A fresh presigned URL for an avatar of this user. */
  async url(
    userId: string,
    actor: AvatarActor,
    objectName: string | undefined,
  ): Promise<AvatarUrl> {
    await this.assertCanManage(userId, actor);
    if (!objectName) {
      throw AppError.validation([
        { field: 'key', description: 'Query param ?key= is required' },
      ]);
    }
    if (
      !objectName.startsWith(avatarPrefix(userId)) ||
      objectName.includes('..')
    ) {
      throw AppError.validation([
        { field: 'key', description: 'Invalid object key' },
      ]);
    }
    const url = await this.objects.presignedGet(
      this.tenantCtx.tenant,
      objectName,
      AVATAR_URL_TTL_SECONDS,
      { contentDisposition: AVATAR_DISPOSITION },
    );
    return { url, objectName };
  }

  /**
   * Owner or admin, and the target must be a member of the caller's tenant
   * (USER_NOT_FOUND otherwise), so an admin acts on their own tenant only.
   */
  private async assertCanManage(
    targetUserId: string,
    actor: AvatarActor,
  ): Promise<void> {
    if (
      actor.userId !== targetUserId &&
      !actor.roles?.includes(UserRole.ADMIN)
    ) {
      throw new AppError('FORBIDDEN', {
        detail: 'You may only manage your own avatar',
      });
    }
    await this.users.findById(targetUserId);
  }
}
