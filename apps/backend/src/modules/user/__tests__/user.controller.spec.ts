import { AppError } from '../../../common/errors';
import { toTenantId } from '../../../common/keyspace';
import { TenantContext } from '../../../common/tenant/tenant.context';
import type { ObjectsPort } from '../../../infrastructure/objects/objects.port';
import { UserController } from '../controllers/user.controller';
import { UserAvatarService } from '../services/user-avatar.service';
import type { UserService } from '../services/user.service';

const TENANT = toTenantId('acme');
const OWN_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const FOREIGN_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

describe('UserController avatars', () => {
  let userService: { findById: jest.Mock };
  let objects: { put: jest.Mock; presignedGet: jest.Mock };
  let controller: UserController;
  const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  const file = {
    buffer: PNG,
    originalname: 'me.png',
    size: PNG.length,
    mimetype: 'image/png',
  };
  const admin = { userId: 'admin-1', roles: ['admin'] };

  beforeEach(() => {
    userService = {
      findById: jest.fn((id: string) =>
        id === FOREIGN_ID
          ? Promise.reject(new AppError('USER_NOT_FOUND'))
          : Promise.resolve({ id }),
      ),
    };
    objects = {
      put: jest.fn().mockResolvedValue({ bucket: 'b', key: 'k' }),
      presignedGet: jest.fn().mockResolvedValue('http://signed'),
    };
    const tenantCtx = { tenant: TENANT } as unknown as TenantContext;
    controller = new UserController(
      userService as unknown as UserService,
      new UserAvatarService(
        objects as unknown as ObjectsPort,
        userService as unknown as UserService,
        tenantCtx,
      ),
    );
  });

  it("stores the avatar in the caller's tenant object space", async () => {
    await controller.uploadAvatar(OWN_ID, { userId: OWN_ID, roles: [] }, file);
    expect(objects.put).toHaveBeenCalledWith(
      TENANT,
      expect.stringMatching(new RegExp(`^avatars/${OWN_ID}/.+\\.png$`)),
      file.buffer,
      PNG.length,
      'image/png',
    );
    expect(objects.presignedGet).toHaveBeenCalledWith(
      TENANT,
      expect.any(String),
      3600,
      expect.objectContaining({
        contentDisposition: expect.stringMatching(/^attachment/),
      }),
    );
  });

  // Reproduces the stored XSS: the upload trusted the client's mimetype, so
  // an SVG (or HTML) labelled image/png was stored and served as given.
  it.each([
    [
      'an SVG',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      'image/svg+xml',
      'x.svg',
    ],
    [
      'markup labelled as PNG',
      Buffer.from('<html><script>alert(1)</script></html>'),
      'image/png',
      'x.png',
    ],
    ['an empty file', Buffer.alloc(0), 'image/png', 'x.png'],
  ])('refuses %s', async (_label, buffer, mimetype, originalname) => {
    await expect(
      controller.uploadAvatar(
        OWN_ID,
        { userId: OWN_ID, roles: [] },
        { buffer, mimetype, originalname, size: buffer.length },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(objects.put).not.toHaveBeenCalled();
  });

  it.each([
    ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg', 'jpg'],
    ['gif', Buffer.from('GIF89a......'), 'image/gif', 'gif'],
    [
      'webp',
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([0, 0, 0, 0]),
        Buffer.from('WEBP'),
      ]),
      'image/webp',
      'webp',
    ],
  ])(
    'stores a %s with the type its bytes show, whatever the client claimed',
    async (_label, buffer, type, ext) => {
      await controller.uploadAvatar(
        OWN_ID,
        { userId: OWN_ID, roles: [] },
        {
          buffer,
          mimetype: 'application/octet-stream',
          originalname: 'upload.bin',
          size: buffer.length,
        },
      );
      expect(objects.put).toHaveBeenCalledWith(
        TENANT,
        expect.stringMatching(new RegExp(`\\.${ext}$`)),
        buffer,
        buffer.length,
        type,
      );
    },
  );

  it('serves a fresh URL as an attachment too', async () => {
    await controller.getAvatarUrl(
      OWN_ID,
      { userId: OWN_ID, roles: [] },
      `avatars/${OWN_ID}/x.png`,
    );
    expect(objects.presignedGet).toHaveBeenCalledWith(
      TENANT,
      `avatars/${OWN_ID}/x.png`,
      3600,
      expect.objectContaining({
        contentDisposition: expect.stringMatching(/^attachment/),
      }),
    );
  });

  // Reproduces the gap: an admin could manage the avatar of any user id,
  // including users of other tenants.
  it('refuses an admin acting on a user outside their tenant', async () => {
    await expect(
      controller.uploadAvatar(FOREIGN_ID, admin, file),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    await expect(
      controller.getAvatarUrl(FOREIGN_ID, admin, `avatars/${FOREIGN_ID}/x.png`),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    expect(objects.put).not.toHaveBeenCalled();
    expect(objects.presignedGet).not.toHaveBeenCalled();
  });

  it('refuses a non-admin acting on someone else', async () => {
    await expect(
      controller.uploadAvatar(OWN_ID, { userId: 'other', roles: [] }, file),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
