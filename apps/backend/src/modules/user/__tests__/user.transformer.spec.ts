import { UserTransformer } from '../transformers/user.transformer';
import type { UserDocument } from '../schemas/user.schema';

const doc = (extra: Record<string, unknown> = {}) =>
  ({
    _id: 'u1',
    name: 'Ada',
    email: 'ada@example.com',
    status: 'active',
    roles: ['member'],
    loginCount: 0,
    ...extra,
  }) as unknown as UserDocument;

describe('UserTransformer', () => {
  it('exposes the schema timestamps as ISO 8601 UTC strings', () => {
    const res = UserTransformer.toResponse(
      doc({
        createdAt: new Date(Date.UTC(2026, 8, 30, 8, 15)),
        updatedAt: new Date(Date.UTC(2026, 9, 1, 9, 0, 0, 500)),
      }),
    );
    expect(res.createdAt).toBe('2026-09-30T08:15:00.000Z');
    expect(res.updatedAt).toBe('2026-10-01T09:00:00.500Z');
  });

  it('omits a timestamp the record lacks', () => {
    const res = UserTransformer.toResponse(doc());
    expect(res).not.toHaveProperty('createdAt');
    expect(res).not.toHaveProperty('updatedAt');
  });
});
