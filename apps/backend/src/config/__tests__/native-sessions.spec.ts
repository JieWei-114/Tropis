import { envValidationSchema } from '../env.validation';
import {
  isNativeCallbackUrl,
  isNativeSessionOrigin,
  nativeOAuthRedirectList,
} from '../cors.constants';

const base = { JWT_SECRET: 'x'.repeat(32) };

describe('native session config', () => {
  describe('isNativeSessionOrigin', () => {
    it.each([
      'tauri://localhost',
      'http://tauri.localhost',
      'capacitor://localhost',
      'https://localhost',
    ])('accepts the shell origin %s', (origin) => {
      expect(isNativeSessionOrigin(origin, 'http://localhost:5173')).toBe(true);
    });

    it.each([
      undefined,
      '',
      'http://localhost',
      'http://localhost:5173',
      'https://console.example.com',
      'https://evil.example',
      'null',
    ])('refuses %s', (origin) => {
      expect(isNativeSessionOrigin(origin, 'http://localhost:5173')).toBe(
        false,
      );
    });

    it('never treats a configured web origin as native', () => {
      expect(
        isNativeSessionOrigin(
          'https://localhost',
          'https://console.example.com, https://localhost',
        ),
      ).toBe(false);
    });
  });

  describe('isNativeCallbackUrl', () => {
    it.each(['tropis://auth/callback', 'com.example.app:/oauth'])(
      'accepts %s',
      (url) => expect(isNativeCallbackUrl(url)).toBe(true),
    );

    it.each([
      'https://evil.example/cb',
      'http://localhost/cb',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'tropis://auth/callback#x',
      'tropis://user:pw@auth/callback',
      'not a url',
      '',
    ])('refuses %s', (url) => expect(isNativeCallbackUrl(url)).toBe(false));
  });

  describe('NATIVE_OAUTH_REDIRECTS', () => {
    const check = (value?: string) =>
      envValidationSchema.validate(
        value === undefined ? base : { ...base, NATIVE_OAUTH_REDIRECTS: value },
      ) as { error?: Error; value: Record<string, unknown> };

    it('defaults to tropis://auth/callback', () => {
      expect(check().value.NATIVE_OAUTH_REDIRECTS).toBe(
        'tropis://auth/callback',
      );
      expect(nativeOAuthRedirectList(undefined)).toEqual([
        'tropis://auth/callback',
      ]);
    });

    it('accepts a list and an empty value (native OAuth off)', () => {
      expect(check('tropis://auth/callback, other://cb').error).toBeUndefined();
      expect(check('').error).toBeUndefined();
      expect(nativeOAuthRedirectList('')).toEqual([]);
    });

    it.each([
      'https://evil.example/cb',
      'tropis://auth/callback,https://evil.example',
      'javascript:alert(1)',
      'tropis://auth/callback#frag',
    ])('rejects %s', (value) => {
      expect(check(value).error).toBeDefined();
    });
  });
});
