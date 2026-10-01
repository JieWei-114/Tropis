import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLegacyTokens,
  clearToken,
  getToken,
  onTokenChange,
  setToken,
} from '../token';
import { createRefresher } from '../refresh';
import {
  OAUTH_VERIFIER_KEY,
  beginPkce,
  codeChallenge,
  createCodeVerifier,
  takePkceVerifier,
} from '../pkce';
import { createApi } from '../../api';
import { jwt, memoryStorage } from './storage';

afterEach(() => {
  clearToken();
  vi.unstubAllGlobals();
});

describe('token store', () => {
  it('keeps the access token in memory, never in Web Storage', () => {
    const local = memoryStorage();
    const session = memoryStorage();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    const token = jwt();

    setToken(token);

    expect(getToken()).toBe(token);
    expect(local.length).toBe(0);
    expect(session.length).toBe(0);
  });

  it('answers null for an expired token without dropping it', () => {
    const changes: Array<string | null> = [];
    onTokenChange((t) => changes.push(t));
    const expired = jwt(-10);
    setToken(expired);
    expect(getToken()).toBeNull();
    expect(changes).toEqual([expired]);
  });

  it('notifies listeners on set and clear', () => {
    const changes: Array<string | null> = [];
    const off = onTokenChange((t) => changes.push(t));
    const token = jwt();
    setToken(token);
    clearToken();
    off();
    setToken(jwt());
    expect(changes).toEqual([token, null]);
  });

  it('removes tokens an older SDK left in localStorage', () => {
    const local = memoryStorage({
      token: 'old',
      refresh_token: 'old-rt',
      theme: 'dark',
    });
    vi.stubGlobal('localStorage', local);
    clearLegacyTokens();
    expect(local.getItem('token')).toBeNull();
    expect(local.getItem('refresh_token')).toBeNull();
    expect(local.getItem('theme')).toBe('dark');
  });
});

describe('cookie refresher', () => {
  it('posts with the cookie and the client header and no body, then stores the token', async () => {
    const token = jwt();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ accessToken: token }), { status: 200 }),
      );

    await expect(
      createRefresher('http://api.test/', { fetchImpl })(),
    ).resolves.toBe(token);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/auth/refresh');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({ 'x-tropis-client': '1' });
    expect(getToken()).toBe(token);
  });

  it('gives up on a refresh that does not answer in time', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const pending = createRefresher('http://api.test', {
      fetchImpl,
      timeoutMs: 1000,
    })();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeNull();
    vi.useRealTimers();
  });

  it('treats 204 as no session', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      createRefresher('http://api.test', { fetchImpl })(),
    ).resolves.toBeNull();
    expect(getToken()).toBeNull();
  });

  it('shares one request between concurrent callers', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ accessToken: jwt() }), { status: 200 }),
    );
    const refresh = createRefresher('http://api.test', { fetchImpl });
    const [a, b] = await Promise.all([refresh(), refresh()]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serialises refreshes across tabs through the Web Locks API', async () => {
    const request = vi.fn(<T>(_name: string, cb: () => Promise<T>) => cb());
    vi.stubGlobal('navigator', { locks: { request } });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ accessToken: jwt() }), { status: 200 }),
    );
    await createRefresher('http://api.test', { fetchImpl })();
    expect(request).toHaveBeenCalledWith(
      'tropis-auth-refresh',
      expect.any(Function),
    );
  });

  it('ends the session when the cookie is rejected', async () => {
    setToken(jwt());
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      createRefresher('http://api.test', { fetchImpl })(),
    ).resolves.toBeNull();
    expect(getToken()).toBeNull();
  });

  it('keeps the token on a network failure', async () => {
    const token = jwt();
    setToken(token);
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('offline'));
    await expect(
      createRefresher('http://api.test', { fetchImpl })(),
    ).resolves.toBeNull();
    expect(getToken()).toBe(token);
  });
});

describe('PKCE', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
  });

  it('creates a 43-character base64url verifier', () => {
    const v = createCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createCodeVerifier()).not.toBe(v);
  });

  it('derives the S256 challenge', async () => {
    const v = createCodeVerifier();
    const expected = createHash('sha256').update(v).digest('base64url');
    await expect(codeChallenge(v)).resolves.toBe(expected);
  });

  it('stores the verifier for exactly one exchange', async () => {
    const challenge = await beginPkce();
    const verifier = sessionStorage.getItem(OAUTH_VERIFIER_KEY)!;
    await expect(codeChallenge(verifier)).resolves.toBe(challenge);
    expect(takePkceVerifier()).toBe(verifier);
    expect(takePkceVerifier()).toBeNull();
  });
});

describe('api session', () => {
  const api = () =>
    createApi({
      rpcBaseUrl: 'http://rpc.test',
      restBaseUrl: 'http://api.test',
      tenantId: 'acme',
    });

  it('restores the session from the refresh cookie and clears legacy tokens', async () => {
    const local = memoryStorage({ token: 'legacy', refresh_token: 'legacy' });
    vi.stubGlobal('localStorage', local);
    const token = jwt();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ accessToken: token }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api().restoreSession()).resolves.toBe(true);

    expect(getToken()).toBe(token);
    expect(local.length).toBe(0);
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/api/auth/refresh');
  });

  it('reports no session when the cookie is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
    await expect(api().restoreSession()).resolves.toBe(false);
    expect(getToken()).toBeNull();
  });

  it('logs in into memory and logs out everywhere', async () => {
    const token = jwt();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: token }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const a = api();

    await a.login('a@b.co', 'password1');
    expect(a.getToken()).toBe(token);
    await a.logout();

    expect(getToken()).toBeNull();
    expect(fetchMock.mock.calls[1][0]).toBe('http://api.test/api/auth/logout');
  });

  it('runs an OAuth sign-in with a verifier bound to its challenge', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    const token = jwt();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ accessToken: token }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const a = api();

    const url = new URL(await a.startOAuthSignIn('google'));
    expect(url.origin + url.pathname).toBe('http://api.test/api/auth/google');
    const challenge = url.searchParams.get('challenge')!;

    await a.completeOAuthSignIn('one-time');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      code: string;
      verifier: string;
    };
    expect(body.code).toBe('one-time');
    expect(createHash('sha256').update(body.verifier).digest('base64url')).toBe(
      challenge,
    );
    expect(getToken()).toBe(token);
  });

  it('refuses a callback this tab did not start', async () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(api().completeOAuthSignIn('planted')).rejects.toThrow(
      /not started in this browser tab/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
