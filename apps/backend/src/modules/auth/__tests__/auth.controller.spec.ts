import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppError, validationExceptionFactory } from '../../../common/errors';
import { GlobalExceptionFilter } from '../../../common/filters/http-exception.filter';
import { TOKEN_VERIFIER } from '../../../common/auth/token-verifier.port';
import { TenantContext } from '../../../common/tenant/tenant.context';
import { toTenantId } from '../../../common/keyspace';
import { AuthController } from '../controllers/auth.controller';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { OAuthConfiguredGuard } from '../guards/oauth-configured.guard';
import { AuthService } from '../services/auth.service';
import { OAuthService } from '../services/oauth.service';
import {
  REFRESH_COOKIE,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../constants/auth.constants';

const ORIGIN = 'http://localhost:5173';
const NATIVE_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'capacitor://localhost',
  'https://localhost',
];
const VERIFIER = 'v'.repeat(43);

const principal = {
  userId: 'u1',
  email: 'alice@example.com',
  roles: ['member'],
  tenantId: toTenantId('acme'),
  jti: 'jti-1',
  exp: Math.floor(Date.now() / 1000) + 900,
};

describe('AuthController (REST)', () => {
  let app: INestApplication;
  let env: Record<string, string | undefined>;
  const auth = {
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
    refreshTokenOwner: jest.fn(),
  };
  const oauth = { exchange: jest.fn(), signIn: jest.fn() };
  const verifier = { verify: jest.fn() };

  const boot = async (values: Record<string, string | undefined> = {}) => {
    env = { NODE_ENV: 'test', ...values };
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: OAuthService, useValue: oauth },
        { provide: TOKEN_VERIFIER, useValue: verifier },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        OAuthConfiguredGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (k: string, d?: unknown) => env[k] ?? d,
            getOrThrow: (k: string) => env[k],
          },
        },
        {
          provide: TenantContext,
          useValue: { tenant: toTenantId('acme') },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: validationExceptionFactory,
      }),
    );
    await app.init();
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    auth.login.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt-1' });
    auth.refresh.mockResolvedValue({
      accessToken: 'at2',
      refreshToken: 'rt-2',
    });
    auth.logout.mockResolvedValue(undefined);
    oauth.exchange.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt-1',
    });
    verifier.verify.mockResolvedValue(principal);
    await boot();
  });

  afterEach(() => app.close());

  const http = () => request(app.getHttpServer() as Server);
  const bodyOf = (res: request.Response) =>
    res.body as { code?: string; refreshToken?: string };
  const cookieOf = (res: request.Response): string | undefined =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  const browser = (req: request.Test) =>
    req.set('Origin', ORIGIN).set('X-Tropis-Client', '1');

  // Reproduces the gap: the refresh token was returned in the JSON body,
  // where any script on the page (XSS) could read and exfiltrate it.
  it('login answers 200 with the access token only and sets the refresh cookie', async () => {
    const res = await http()
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'password1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accessToken: 'at' });
    const cookie = cookieOf(res)!;
    expect(cookie).toContain(`${REFRESH_COOKIE}=rt-1`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(cookie).toMatch(new RegExp(`Max-Age=${REFRESH_TOKEN_TTL_SECONDS}`));
    expect(cookie).not.toMatch(/Secure/);
  });

  it('marks the cookie Secure in production and when COOKIE_SECURE says so', async () => {
    await app.close();
    await boot({ NODE_ENV: 'production' });
    let res = await http()
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'password1' });
    expect(cookieOf(res)).toMatch(/Secure/);

    await app.close();
    await boot({ NODE_ENV: 'development', COOKIE_SECURE: 'true' });
    res = await http()
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'password1' });
    expect(cookieOf(res)).toMatch(/Secure/);
  });

  it('refresh reads the cookie, rotates it and answers the access token only', async () => {
    const res = await browser(
      http().post('/api/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=rt-1`),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accessToken: 'at2' });
    expect(auth.refresh).toHaveBeenCalledWith('rt-1');
    expect(cookieOf(res)).toContain(`${REFRESH_COOKIE}=rt-2`);
  });

  // A visitor without a session restoring on page load is not an error.
  it('refresh without the cookie answers 204 with no session', async () => {
    const res = await browser(http().post('/api/auth/refresh'));
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('a refresh that fails for an outage keeps the cookie', async () => {
    auth.refresh.mockRejectedValue(new AppError('SERVICE_UNAVAILABLE'));
    const res = await browser(
      http().post('/api/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=rt-1`),
    );
    expect(res.status).toBe(503);
    expect(cookieOf(res) ?? '').not.toMatch(/Max-Age=0/);
  });

  it('a refused refresh clears the cookie', async () => {
    auth.refresh.mockRejectedValue(new AppError('AUTH_TOKEN_REVOKED'));
    const res = await browser(
      http().post('/api/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=rt-1`),
    );
    expect(res.status).toBe(401);
    expect(cookieOf(res)).toMatch(/Max-Age=0/);
  });

  // Cross-site request forgery against the cookie endpoints.
  it.each([
    ['without X-Tropis-Client', (r: request.Test) => r.set('Origin', ORIGIN)],
    [
      'from an origin outside the allow-list',
      (r: request.Test) =>
        r.set('Origin', 'https://evil.example').set('X-Tropis-Client', '1'),
    ],
    [
      'without Origin from a cross-site context',
      (r: request.Test) =>
        r.set('Sec-Fetch-Site', 'cross-site').set('X-Tropis-Client', '1'),
    ],
    [
      'without Origin or Sec-Fetch-Site',
      (r: request.Test) => r.set('X-Tropis-Client', '1'),
    ],
  ])('refuses a refresh %s with AUTH_CSRF_REJECTED', async (_label, shape) => {
    const res = await shape(
      http().post('/api/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=rt-1`),
    );
    expect(res.status).toBe(403);
    expect(bodyOf(res).code).toBe('AUTH_CSRF_REJECTED');
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('accepts a same-origin request without Origin', async () => {
    const res = await http()
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=rt-1`)
      .set('Sec-Fetch-Site', 'same-origin')
      .set('X-Tropis-Client', '1');
    expect(res.status).toBe(200);
  });

  it('logout revokes the cookie token and the access token, clears the cookie, 204', async () => {
    const res = await browser(
      http()
        .post('/api/auth/logout')
        .set('Cookie', `${REFRESH_COOKIE}=rt-1`)
        .set('Authorization', 'Bearer access'),
    );
    expect(res.status).toBe(204);
    expect(auth.logout).toHaveBeenCalledWith('jti-1', principal.exp, 'rt-1');
    expect(cookieOf(res)).toMatch(/Max-Age=0/);
  });

  it('logout still ends the cookie session when the access token is gone', async () => {
    verifier.verify.mockRejectedValue(new AppError('AUTH_TOKEN_INVALID'));
    const res = await browser(
      http()
        .post('/api/auth/logout')
        .set('Cookie', `${REFRESH_COOKIE}=rt-1`)
        .set('Authorization', 'Bearer expired'),
    );
    expect(res.status).toBe(204);
    expect(auth.logout).toHaveBeenCalledWith(undefined, undefined, 'rt-1');
  });

  it('logout is CSRF-protected', async () => {
    const res = await http()
      .post('/api/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE}=rt-1`)
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(auth.logout).not.toHaveBeenCalled();
  });

  // Reproduces the gap: /me returned the raw principal, jti and exp included.
  it('me answers a defined profile without token internals', async () => {
    const res = await http()
      .get('/api/auth/me')
      .set('Authorization', 'Bearer access');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: 'u1',
      email: 'alice@example.com',
      tenantId: 'acme',
      roles: ['member'],
    });
  });

  it('exchange trades code and verifier, sets the cookie and answers the access token', async () => {
    const res = await http()
      .post('/api/auth/oauth/exchange')
      .send({ code: 'c'.repeat(43), verifier: VERIFIER });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accessToken: 'at' });
    expect(oauth.exchange).toHaveBeenCalledWith(
      'c'.repeat(43),
      VERIFIER,
      'web',
    );
    expect(cookieOf(res)).toContain(`${REFRESH_COOKIE}=rt-1`);
  });

  it('exchange requires a well-formed verifier', async () => {
    const res = await http()
      .post('/api/auth/oauth/exchange')
      .send({ code: 'c'.repeat(43), verifier: 'short' });
    expect(res.status).toBe(400);
    expect(bodyOf(res).code).toBe('VALIDATION_FAILED');
    expect(oauth.exchange).not.toHaveBeenCalled();
  });

  describe('native shells', () => {
    const native = (req: request.Test, origin = 'tauri://localhost') =>
      req.set('Origin', origin).set('X-Tropis-Client', 'native');
    const login = () =>
      http()
        .post('/api/auth/login')
        .send({ email: 'alice@example.com', password: 'password1' });

    it.each(NATIVE_ORIGINS)(
      'login from %s answers both tokens in the body and sets no cookie',
      async (origin) => {
        const res = await native(login(), origin);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ accessToken: 'at', refreshToken: 'rt-1' });
        expect(cookieOf(res)).toBeUndefined();
      },
    );

    // A browser page must never receive the refresh token in a body.
    it.each([
      ['the web console', ORIGIN],
      ['a foreign site', 'https://evil.example'],
      ['plain http://localhost', 'http://localhost'],
      ['the string null', 'null'],
    ])(
      'refuses a native login from %s before checking credentials',
      async (_label, origin) => {
        const res = await native(login(), origin);
        expect(res.status).toBe(403);
        expect(bodyOf(res).code).toBe('AUTH_CSRF_REJECTED');
        expect(bodyOf(res).refreshToken).toBeUndefined();
        expect(auth.login).not.toHaveBeenCalled();
      },
    );

    it('refuses a native login without an Origin', async () => {
      const res = await login().set('X-Tropis-Client', 'native');
      expect(res.status).toBe(403);
      expect(auth.login).not.toHaveBeenCalled();
    });

    it('never treats a configured web origin as native', async () => {
      await app.close();
      await boot();
      const saved = process.env.CORS_ORIGIN;
      process.env.CORS_ORIGIN = 'https://localhost';
      try {
        const res = await native(login(), 'https://localhost');
        expect(res.status).toBe(403);
        expect(auth.login).not.toHaveBeenCalled();
      } finally {
        if (saved === undefined) delete process.env.CORS_ORIGIN;
        else process.env.CORS_ORIGIN = saved;
      }
    });

    it('a web login from a native origin still uses the cookie', async () => {
      const res = await login().set('Origin', 'tauri://localhost');
      expect(res.body).toEqual({ accessToken: 'at' });
      expect(cookieOf(res)).toContain(`${REFRESH_COOKIE}=rt-1`);
    });

    it('native refresh rotates the body token and answers a new pair', async () => {
      const res = await native(
        http().post('/api/auth/native/refresh').send({ refreshToken: 'rt-1' }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accessToken: 'at2', refreshToken: 'rt-2' });
      expect(auth.refresh).toHaveBeenCalledWith('rt-1');
      expect(cookieOf(res)).toBeUndefined();
    });

    it('native refresh ignores the cookie', async () => {
      const res = await native(
        http()
          .post('/api/auth/native/refresh')
          .set('Cookie', `${REFRESH_COOKIE}=rt-cookie`)
          .send({}),
      );
      expect(res.status).toBe(400);
      expect(auth.refresh).not.toHaveBeenCalled();
    });

    it('native refresh answers a refused token as 401', async () => {
      auth.refresh.mockRejectedValue(new AppError('AUTH_TOKEN_REVOKED'));
      const res = await native(
        http().post('/api/auth/native/refresh').send({ refreshToken: 'rt-1' }),
      );
      expect(res.status).toBe(401);
      expect(bodyOf(res).code).toBe('AUTH_TOKEN_REVOKED');
    });

    it.each([
      [
        'from the web console',
        (r: request.Test) =>
          r.set('Origin', ORIGIN).set('X-Tropis-Client', 'native'),
      ],
      [
        'with the web client header',
        (r: request.Test) =>
          r.set('Origin', 'tauri://localhost').set('X-Tropis-Client', '1'),
      ],
      [
        'without the client header',
        (r: request.Test) => r.set('Origin', 'tauri://localhost'),
      ],
    ])('refuses a native refresh %s', async (_label, shape) => {
      const res = await shape(
        http().post('/api/auth/native/refresh').send({ refreshToken: 'rt-1' }),
      );
      expect(res.status).toBe(403);
      expect(bodyOf(res).code).toBe('AUTH_CSRF_REJECTED');
      expect(auth.refresh).not.toHaveBeenCalled();
    });

    it('the cookie endpoints refuse the native client header', async () => {
      const res = await native(
        http()
          .post('/api/auth/refresh')
          .set('Cookie', `${REFRESH_COOKIE}=rt-1`),
      );
      expect(res.status).toBe(403);
      expect(auth.refresh).not.toHaveBeenCalled();
    });

    it('native logout revokes the body token and the access token', async () => {
      const res = await native(
        http()
          .post('/api/auth/native/logout')
          .set('Authorization', 'Bearer access')
          .send({ refreshToken: 'rt-1' }),
      );
      expect(res.status).toBe(204);
      expect(auth.logout).toHaveBeenCalledWith('jti-1', principal.exp, 'rt-1');
      expect(cookieOf(res)).toBeUndefined();
    });

    it('native logout from a web origin is refused', async () => {
      const res = await http()
        .post('/api/auth/native/logout')
        .set('Origin', ORIGIN)
        .set('X-Tropis-Client', 'native')
        .send({ refreshToken: 'rt-1' });
      expect(res.status).toBe(403);
      expect(auth.logout).not.toHaveBeenCalled();
    });

    it('native exchange answers both tokens for a native code', async () => {
      const res = await native(
        http()
          .post('/api/auth/oauth/exchange')
          .send({ code: 'c'.repeat(43), verifier: VERIFIER }),
        'capacitor://localhost',
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accessToken: 'at', refreshToken: 'rt-1' });
      expect(oauth.exchange).toHaveBeenCalledWith(
        'c'.repeat(43),
        VERIFIER,
        'native',
      );
      expect(cookieOf(res)).toBeUndefined();
    });

    it('a native exchange from a web origin is refused before the code is spent', async () => {
      const res = await http()
        .post('/api/auth/oauth/exchange')
        .set('Origin', ORIGIN)
        .set('X-Tropis-Client', 'native')
        .send({ code: 'c'.repeat(43), verifier: VERIFIER });
      expect(res.status).toBe(403);
      expect(oauth.exchange).not.toHaveBeenCalled();
    });
  });
});
