import type { UnaryRequest } from '@connectrpc/connect';
import { serviceIdentityInterceptor } from '../interceptors/service-identity.interceptor';

const GUARDED = 'tropis.user.internal.v1.UserInternalService';

const request = (service: string, headers: Record<string, string> = {}) =>
  ({
    service: { typeName: service },
    header: new Headers(headers),
  }) as unknown as UnaryRequest;

describe('serviceIdentityInterceptor', () => {
  let token: string;
  const next = jest.fn().mockResolvedValue('handled');
  const run = (req: UnaryRequest) =>
    serviceIdentityInterceptor(() => token, new Set([GUARDED]))(next)(req);

  beforeEach(() => {
    token = 'svc-token';
    next.mockClear();
  });

  it('passes a guarded call with the right token', async () => {
    await expect(
      run(request(GUARDED, { 'x-service-token': 'svc-token' })),
    ).resolves.toBe('handled');
  });

  it.each<Record<string, string>>([
    {},
    { 'x-service-token': 'wrong' },
    { 'x-service-token': 'svc' },
  ])('refuses a missing or wrong token (%p)', async (headers) => {
    await expect(run(request(GUARDED, headers))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('disables the guarded services when no token is configured', async () => {
    token = '';
    await expect(
      run(request(GUARDED, { 'x-service-token': '' })),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves health and other unguarded services alone', async () => {
    await expect(run(request('grpc.health.v1.Health'))).resolves.toBe(
      'handled',
    );
  });
});
