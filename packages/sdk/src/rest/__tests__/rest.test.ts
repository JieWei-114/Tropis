import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, parseApiError } from '../../errors/index';
import { createRestClient } from '../index';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

function problemResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/problem+json',
      'x-request-id': TRACE_ID,
    },
  });
}

describe('rest client errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = () =>
    createRestClient({ baseUrl: 'http://api.test', getToken: () => null });

  // The backend answers RFC 9457 problem details, which have no `message`
  // member — reading one surfaced only the bare code to the login screen.
  it('surfaces the field reasons of a validation problem on login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        problemResponse(400, {
          type: 'https://errors.tropis.dev/validation-failed',
          title: 'One or more fields are invalid.',
          status: 400,
          code: 'VALIDATION_FAILED',
          traceId: TRACE_ID,
          retryable: false,
          errors: [
            {
              field: 'password',
              description:
                'password must be longer than or equal to 8 characters',
            },
          ],
        }),
      ),
    );

    const err = await client()
      .login('a@b.co', 'short')
      .catch((e) => e);

    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.message).toBe(
      'password must be longer than or equal to 8 characters',
    );
    expect(parseApiError(err)).toMatchObject({
      code: 'VALIDATION_FAILED',
      traceId: TRACE_ID,
      fieldErrors: [{ field: 'password' }],
    });
  });

  it('surfaces the problem title of a rejected login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        problemResponse(401, {
          type: 'https://errors.tropis.dev/unauthorized',
          title: 'Invalid credentials.',
          status: 401,
          code: 'UNAUTHORIZED',
          retryable: false,
        }),
      ),
    );

    const err = await client()
      .login('a@b.co', 'wrong-password')
      .catch((e) => e);

    expect(err.message).toBe('Invalid credentials.');
    expect(parseApiError(err)).toMatchObject({
      code: 'UNAUTHORIZED',
      isAuth: true,
    });
  });
});

describe('rest client tenant', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the configured tenant on login, which carries no token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'a', refreshToken: 'r' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createRestClient({
      baseUrl: 'http://api.test',
      tenantId: 'acme',
    }).login('a@b.co', 'password1');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ 'x-tenant-id': 'acme' });
  });
});

describe('rest client trace context', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const headersOf = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.map(
      ([, init]) => (init as RequestInit).headers as Record<string, string>,
    );

  it('sends a fresh traceparent on login when no trace is active', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'a', refreshToken: 'r' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createRestClient({ baseUrl: 'http://api.test' }).login(
      'a@b.co',
      'password1',
    );

    expect(headersOf(fetchMock)[0]!.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
  });

  it('propagates the caller-provided traceparent on both attempts of a refreshed call', async () => {
    const active = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'https://cdn/x.png' }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await createRestClient({
      baseUrl: 'http://api.test',
      getToken: () => 'tok',
      refresh: async () => 'tok-2',
      traceparent: () => active,
    }).uploadAvatar('u1', new File(['x'], 'a.png'));

    expect(headersOf(fetchMock).map((h) => h.traceparent)).toEqual([
      active,
      active,
    ]);
  });
});

describe('rest client OAuth code exchange', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the one-time code with the verifier and returns the access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'at' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const tokens = await createRestClient({
      baseUrl: 'http://api.test/',
    }).exchangeOAuthCode('one-time', 'verifier-1');

    expect(tokens).toEqual({ accessToken: 'at' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/api/auth/oauth/exchange');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.headers['x-tropis-client']).toBe('1');
    expect(JSON.parse(init.body)).toEqual({
      code: 'one-time',
      verifier: 'verifier-1',
    });
  });

  it('surfaces a rejected code as an API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        problemResponse(401, {
          type: 'https://errors.tropis.dev/oauth-code-invalid',
          title: 'The sign-in code is invalid or has expired.',
          status: 401,
          code: 'OAUTH_CODE_INVALID',
          traceId: TRACE_ID,
          retryable: false,
        }),
      ),
    );
    const err = await createRestClient({ baseUrl: 'http://api.test' })
      .exchangeOAuthCode('stale', 'v')
      .catch((e) => e);
    expect(parseApiError(err)).toMatchObject({ code: 'OAUTH_CODE_INVALID' });
  });
});

describe('rest client auth endpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs in with credentials and the client header, with no refresh token in the body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ accessToken: 'a' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const res = await createRestClient({ baseUrl: 'http://api.test' }).login(
      'a@b.co',
      'password1',
    );

    expect(res).toEqual({ accessToken: 'a' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe('include');
    expect(init.headers).toMatchObject({ 'x-tropis-client': '1' });
  });

  it('logs out with the cookie, the client header and the bearer token, and no body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await createRestClient({
      baseUrl: 'http://api.test',
      getToken: () => 'tok',
    }).logout();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/auth/logout');
    expect(init.credentials).toBe('include');
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({
      'x-tropis-client': '1',
      Authorization: 'Bearer tok',
    });
  });

  it('swallows a logout network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('x')));
    await expect(
      createRestClient({ baseUrl: 'http://api.test' }).logout(),
    ).resolves.toBeUndefined();
  });

  it('builds the OAuth start URL with the challenge', () => {
    expect(
      createRestClient({ baseUrl: 'http://api.test/' }).oauthStartUrl(
        'github',
        'abc-_',
      ),
    ).toBe('http://api.test/api/auth/github?challenge=abc-_');
  });
});

describe('rest client roles and workflows', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads and writes roles with the bearer token, refreshing on 401', async () => {
    let token = 'old';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ userId: 'u1', roles: ['admin'] }],
            nextPageToken: '',
            totalSize: 1,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'u1', roles: ['viewer'] }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = createRestClient({
      baseUrl: 'http://api.test',
      getToken: () => token,
      refresh: async () => (token = 'new'),
    });

    expect(await client.getUserRoles()).toEqual({
      items: [{ userId: 'u1', roles: ['admin'] }],
      nextPageToken: '',
      totalSize: 1,
    });
    expect(await client.setUserRoles('u1', ['viewer'])).toEqual({
      id: 'u1',
      roles: ['viewer'],
    });

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(
      calls.map(([, i]) => (i.headers as Record<string, string>).Authorization),
    ).toEqual(['Bearer old', 'Bearer new', 'Bearer new']);
    expect(calls[0]![0]).toBe('http://api.test/api/users/roles');
    expect(calls[2]![0]).toBe('http://api.test/api/users/u1/roles');
    expect(calls[2]![1].method).toBe('PATCH');
    expect(JSON.parse(calls[2]![1].body as string)).toEqual({
      roles: ['viewer'],
    });
  });

  it('sends the page size and token only when set', async () => {
    const page = { items: [], nextPageToken: '', totalSize: 0 };
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify(page), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = createRestClient({ baseUrl: 'http://api.test' });

    await client.getUserRoles({ pageSize: 50, pageToken: 'tok/+=' });
    await client.getUserRoles({ pageSize: 10 });
    await client.getUserRoles({ pageToken: '' });

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'http://api.test/api/users/roles?pageSize=50&pageToken=tok%2F%2B%3D',
      'http://api.test/api/users/roles?pageSize=10',
      'http://api.test/api/users/roles',
    ]);
  });

  it('surfaces a role change rejection as the problem it is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        problemResponse(409, {
          type: 'https://errors.tropis.dev/user-last-admin',
          title: 'The last admin of a tenant cannot be removed.',
          status: 409,
          code: 'USER_LAST_ADMIN',
          retryable: false,
        }),
      ),
    );
    const err = await createRestClient({ baseUrl: 'http://api.test' })
      .setUserRoles('u1', ['viewer'])
      .catch((e) => e);
    expect(parseApiError(err)).toMatchObject({
      code: 'USER_LAST_ADMIN',
      message: 'The last admin of a tenant cannot be removed.',
    });
  });

  it('lists onboarding workflows', async () => {
    const body = {
      available: true,
      summary: { running: 1, completed: 0 },
      items: [
        {
          workflowId: 'onboarding-u1',
          userId: 'u1',
          status: 'RUNNING',
          startTime: '2026-10-02T08:00:00.000Z',
          closeTime: null,
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await createRestClient({
        baseUrl: 'http://api.test',
      }).listOnboardingWorkflows(),
    ).toEqual(body);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://api.test/api/workflows/onboarding',
    );
  });
});

describe('rest client health', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the capability report of a healthy server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'ok',
            info: {},
            error: {},
            details: {
              cache: { status: 'up', adapter: 'redis' },
              graph: { status: 'up', adapter: 'disabled', disabled: true },
              search: { status: 'down', adapter: 'elasticsearch' },
            },
            degraded: ['search'],
          }),
          { status: 200 },
        ),
      ),
    );
    expect(
      await createRestClient({ baseUrl: 'http://api.test' }).getHealth(),
    ).toEqual({
      status: 'ok',
      checks: [
        { name: 'cache', status: 'up', adapter: 'redis' },
        { name: 'graph', status: 'up', adapter: 'disabled', disabled: true },
        { name: 'search', status: 'down', adapter: 'elasticsearch' },
      ],
      degraded: ['search'],
    });
  });

  it('reads checks[] from the problem of a failing server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        problemResponse(503, {
          type: 'https://errors.tropis.dev/health-check-failed',
          title: 'One or more dependencies are unavailable.',
          status: 503,
          code: 'HEALTH_CHECK_FAILED',
          retryable: true,
          checks: [
            { name: 'documents', status: 'down' },
            { name: 'cache', status: 'up' },
          ],
        }),
      ),
    );
    expect(
      await createRestClient({ baseUrl: 'http://api.test' }).getHealth(),
    ).toEqual({
      status: 'error',
      checks: [
        { name: 'documents', status: 'down' },
        { name: 'cache', status: 'up' },
      ],
      degraded: [],
    });
  });

  it('throws on a body that is no health report', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>', { status: 502 })),
    );
    const err = await createRestClient({ baseUrl: 'http://api.test' })
      .getHealth()
      .catch((e) => e);
    expect(parseApiError(err)).toMatchObject({ code: 'BAD_GATEWAY' });
  });
});
