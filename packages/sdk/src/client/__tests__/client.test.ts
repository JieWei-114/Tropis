import { afterEach, describe, expect, it, vi } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import { createSdk } from '../index';

const BASE = 'http://localhost:50051';

function stubFetch(responses: Response[]) {
  const calls: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      const next = responses.shift();
      if (!next) throw new Error('unexpected fetch');
      return next;
    }),
  );
  return calls;
}

const ok = () =>
  new Response(new Uint8Array(), {
    status: 200,
    headers: { 'content-type': 'application/proto' },
  });

const unauthenticated = () =>
  new Response(
    JSON.stringify({ code: 'unauthenticated', message: 'expired' }),
    {
      status: 401,
      headers: { 'content-type': 'application/json' },
    },
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSdk', () => {
  it('calls the backend directly with the binary Connect protocol and the bearer token', async () => {
    const calls = stubFetch([ok()]);
    const sdk = createSdk({ baseUrl: BASE, getToken: () => 'tok-1' });

    await sdk.users.getMe({});

    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.url).toBe(`${BASE}/tropis.user.v1.UserService/GetMe`);
    expect(req.method).toBe('POST');
    expect(req.headers.get('content-type')).toBe('application/proto');
    expect(req.headers.get('connect-protocol-version')).toBe('1');
    expect(req.headers.get('authorization')).toBe('Bearer tok-1');
  });

  it('names the configured tenant on every call, with or without a token', async () => {
    const calls = stubFetch([ok()]);
    const sdk = createSdk({ baseUrl: BASE, tenantId: 'acme' });

    await sdk.auth.login({ email: 'a@b.co', password: 'password1' });

    expect(calls[0].headers.get('x-tenant-id')).toBe('acme');
    expect(calls[0].headers.get('authorization')).toBeNull();
  });

  it('refreshes once on Unauthenticated and retries with the new token', async () => {
    let token = 'old';
    const calls = stubFetch([unauthenticated(), ok()]);
    const refresh = vi.fn(async () => {
      token = 'new';
      return token;
    });
    const sdk = createSdk({ baseUrl: BASE, getToken: () => token, refresh });

    await sdk.users.getMe({});

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.headers.get('authorization'))).toEqual([
      'Bearer old',
      'Bearer new',
    ]);
  });

  it('surfaces the server code as a ConnectError', async () => {
    stubFetch([unauthenticated()]);
    const sdk = createSdk({ baseUrl: BASE });

    const err = await sdk.users.getMe({}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.Unauthenticated);
  });

  it('sends a fresh W3C traceparent per call when no trace is active', async () => {
    const calls = stubFetch([ok(), ok()]);
    const sdk = createSdk({ baseUrl: BASE });

    await sdk.users.getMe({});
    await sdk.users.getMe({});

    const [a, b] = calls.map((c) => c.headers.get('traceparent'));
    expect(a).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(b).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(a!.split('-')[1]).not.toBe(b!.split('-')[1]);
  });

  it('propagates the caller-provided traceparent, also on the refresh retry', async () => {
    const active = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const calls = stubFetch([unauthenticated(), ok()]);
    const sdk = createSdk({
      baseUrl: BASE,
      getToken: () => 'tok',
      refresh: async () => 'tok-2',
      traceparent: () => active,
    });

    await sdk.users.getMe({});

    expect(calls.map((c) => c.headers.get('traceparent'))).toEqual([
      active,
      active,
    ]);
  });
});
