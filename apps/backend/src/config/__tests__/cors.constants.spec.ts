import {
  corsOriginFromEnv,
  primaryWebOrigin,
  NATIVE_APP_ORIGINS,
  DEFAULT_CORS_ORIGIN,
} from '../cors.constants';

/**
 * The allow-list must always carry the packaged clients' origins: the Tauri
 * desktop shell and the two Capacitor apps serve from custom schemes, and an
 * allow-list that omits them makes their webviews block every response, so the
 * apps build and launch but cannot sign in.
 *
 * These pin that contract, because nothing else can — the desktop and mobile
 * shells are not exercised by any automated suite.
 */
describe('cors.constants', () => {
  const original = process.env.CORS_ORIGIN;
  afterEach(() => {
    if (original === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = original;
  });

  it('always allows every packaged client origin', () => {
    delete process.env.CORS_ORIGIN;
    const allowed = corsOriginFromEnv();

    for (const origin of NATIVE_APP_ORIGINS) {
      expect(allowed).toContain(origin);
    }
    expect(allowed).toContain(DEFAULT_CORS_ORIGIN);
  });

  it('keeps the native origins even when CORS_ORIGIN is overridden', () => {
    process.env.CORS_ORIGIN = 'https://console.example.com';
    const allowed = corsOriginFromEnv();

    expect(allowed).toContain('https://console.example.com');
    for (const origin of NATIVE_APP_ORIGINS) {
      expect(allowed).toContain(origin);
    }
  });

  it('accepts a comma-separated list of web origins and trims them', () => {
    process.env.CORS_ORIGIN =
      ' https://a.example.com , https://b.example.com ,,';
    const allowed = corsOriginFromEnv();

    expect(allowed).toContain('https://a.example.com');
    expect(allowed).toContain('https://b.example.com');
    expect(allowed).not.toContain('');
  });

  it('de-duplicates, so a configured native origin is not listed twice', () => {
    process.env.CORS_ORIGIN = 'http://localhost:5173,capacitor://localhost';
    const allowed = corsOriginFromEnv();

    expect(new Set(allowed).size).toBe(allowed.length);
  });

  it('never allows an arbitrary origin', () => {
    process.env.CORS_ORIGIN = 'http://localhost:5173';
    expect(corsOriginFromEnv()).not.toContain('https://evil.example.com');
  });

  describe('primaryWebOrigin', () => {
    it('is the first configured WEB origin, never a native scheme', () => {
      process.env.CORS_ORIGIN = 'https://console.example.com';
      const primary = primaryWebOrigin();

      expect(primary).toBe('https://console.example.com');
      // An OAuth provider redirects a real browser here, so a custom scheme
      // would produce an unreachable callback URL.
      expect(NATIVE_APP_ORIGINS).not.toContain(
        primary as (typeof NATIVE_APP_ORIGINS)[number],
      );
    });

    it('falls back to the default when unset', () => {
      delete process.env.CORS_ORIGIN;
      expect(primaryWebOrigin()).toBe(DEFAULT_CORS_ORIGIN);
    });
  });
});
