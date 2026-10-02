import type { Request } from 'express';
import {
  SignedOAuthStateStore,
  oauthChallengeOf,
  oauthRedirectOf,
} from '../strategies/oauth-state.store';
import { OAUTH_STATE_COOKIE } from '../constants/auth.constants';

const SECRET = 'state-secret-state-secret-state-secret';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function browser() {
  const cookies: string[] = [];
  const request = (cookie?: string, query: Record<string, unknown> = {}) =>
    ({
      headers: cookie ? { cookie } : {},
      query,
      secure: false,
      res: { append: (_h: string, v: string) => cookies.push(v) },
    }) as unknown as Request;
  return { cookies, request };
}

function begin(
  store: SignedOAuthStateStore,
  challenge: unknown = CHALLENGE,
  extra: Record<string, unknown> = {},
) {
  const b = browser();
  let state = '';
  store.store(b.request(undefined, { challenge, ...extra }), {}, (err, s) => {
    expect(err).toBeNull();
    state = s!;
  });
  const set = b.cookies[0];
  const nonce = decodeURIComponent(
    set.split(';')[0].slice(OAUTH_STATE_COOKIE.length + 1),
  );
  return { state, cookie: `${OAUTH_STATE_COOKIE}=${nonce}`, setCookie: set };
}

function finish(
  store: SignedOAuthStateStore,
  state: unknown,
  cookie?: string,
  onRequest: (req: Request) => void = () => {},
): Promise<string> {
  const req = browser().request(cookie);
  return new Promise((resolve) =>
    store.verify(req, state, (err, ok) => {
      onRequest(req);
      resolve(err ? String((err as { code?: string }).code) : String(ok));
    }),
  );
}

describe('SignedOAuthStateStore', () => {
  it('binds the state to an HttpOnly, SameSite=Lax cookie on the starting browser', () => {
    const { state, setCookie } = begin(new SignedOAuthStateStore(SECRET));
    expect(state.split('.')).toHaveLength(4);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\/api\/auth/);
  });

  it('accepts the callback in the browser that started the flow', async () => {
    const store = new SignedOAuthStateStore(SECRET);
    const { state, cookie } = begin(store);
    await expect(finish(store, state, cookie)).resolves.toBe('true');
  });

  // Reproduces the gap: the flow had no state, so an attacker could make a
  // victim's browser complete a sign-in into the attacker's account.
  it("rejects a callback without the starting browser's cookie", async () => {
    const store = new SignedOAuthStateStore(SECRET);
    const { state } = begin(store);
    await expect(finish(store, state)).resolves.toBe('OAUTH_STATE_INVALID');
    const other = begin(store);
    await expect(finish(store, state, other.cookie)).resolves.toBe(
      'OAUTH_STATE_INVALID',
    );
  });

  it('rejects a missing, tampered or foreign-signed state', async () => {
    const store = new SignedOAuthStateStore(SECRET);
    const { state, cookie } = begin(store);
    await expect(finish(store, undefined, cookie)).resolves.toBe(
      'OAUTH_STATE_INVALID',
    );
    const [nonce, exp] = state.split('.');
    await expect(
      finish(
        store,
        `${nonce}.${Number(exp) + 999}.${state.split('.').slice(2).join('.')}`,
        cookie,
      ),
    ).resolves.toBe('OAUTH_STATE_INVALID');
    const foreign = begin(new SignedOAuthStateStore('another-secret-another'));
    await expect(finish(store, foreign.state, foreign.cookie)).resolves.toBe(
      'OAUTH_STATE_INVALID',
    );
  });

  it('rejects an expired state', async () => {
    let now = 1_000_000;
    const store = new SignedOAuthStateStore(SECRET, () => now);
    const { state, cookie } = begin(store);
    now += 601_000;
    await expect(finish(store, state, cookie)).resolves.toBe(
      'OAUTH_STATE_INVALID',
    );
  });

  // Reproduces the login CSRF: the flow carried no proof of the browser
  // that started it into the code exchange.
  it('binds the PKCE challenge into the signed state and hands it to the callback', async () => {
    const store = new SignedOAuthStateStore(SECRET);
    const { state, cookie } = begin(store);
    let bound: string | undefined;
    await expect(
      finish(store, state, cookie, (req) => (bound = oauthChallengeOf(req))),
    ).resolves.toBe('true');
    expect(bound).toBe(CHALLENGE);

    const [nonce, exp, , sig] = state.split('.');
    const swapped = `${nonce}.${exp}.${'A'.repeat(43)}.${sig}`;
    await expect(finish(store, swapped, cookie)).resolves.toBe(
      'OAUTH_STATE_INVALID',
    );
  });

  it.each([
    ['missing', undefined],
    ['too short', 'abc'],
    ['not base64url', `${'a'.repeat(42)}=`],
  ])('refuses to start a flow whose challenge is %s', (_label, challenge) => {
    const b = browser();
    let error: unknown;
    new SignedOAuthStateStore(SECRET).store(
      b.request(undefined, { challenge }),
      {},
      (err) => (error = err),
    );
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(b.cookies).toHaveLength(0);
  });

  describe('native redirect', () => {
    const NATIVE = 'tropis://auth/callback';
    const nativeStore = () =>
      new SignedOAuthStateStore(SECRET, Date.now, [NATIVE]);

    const start = (store: SignedOAuthStateStore, redirect: unknown) => {
      const b = browser();
      let error: unknown;
      store.store(
        b.request(undefined, { challenge: CHALLENGE, redirect }),
        {},
        (err) => (error = err),
      );
      return { error, cookies: b.cookies };
    };

    it('carries an allowed redirect through the signed state to the callback', async () => {
      const store = nativeStore();
      const { state, cookie } = begin(store, CHALLENGE, { redirect: NATIVE });
      expect(state.split('.')).toHaveLength(5);
      let redirect: string | undefined;
      await expect(
        finish(
          store,
          state,
          cookie,
          (req) => (redirect = oauthRedirectOf(req)),
        ),
      ).resolves.toBe('true');
      expect(redirect).toBe(NATIVE);
    });

    it('a web flow carries no redirect', async () => {
      const store = nativeStore();
      const { state, cookie } = begin(store);
      let redirect: string | undefined = 'unset';
      await finish(
        store,
        state,
        cookie,
        (req) => (redirect = oauthRedirectOf(req)),
      );
      expect(redirect).toBeUndefined();
    });

    // Open redirect: the callback must never send a code to a URL the
    // allow-list does not hold.
    it.each([
      'https://evil.example/cb',
      'tropis://auth/callback/../evil',
      'tropis://auth/callbackx',
      'evil://auth/callback',
      'javascript:alert(1)',
      '',
      ['tropis://auth/callback'],
    ])('refuses to start a flow with redirect %p', (redirect) => {
      const { error, cookies } = start(nativeStore(), redirect);
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(cookies).toHaveLength(0);
    });

    it('refuses every redirect when none is configured', () => {
      const { error } = start(new SignedOAuthStateStore(SECRET), NATIVE);
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('rejects a state whose redirect was swapped or added', async () => {
      const store = nativeStore();
      const { state, cookie } = begin(store, CHALLENGE, { redirect: NATIVE });
      const parts = state.split('.');
      parts[3] = Buffer.from('https://evil.example').toString('base64url');
      await expect(finish(store, parts.join('.'), cookie)).resolves.toBe(
        'OAUTH_STATE_INVALID',
      );

      const web = begin(store);
      const [n, e, c, sig] = web.state.split('.');
      const added = `${n}.${e}.${c}.${Buffer.from(NATIVE).toString('base64url')}.${sig}`;
      await expect(finish(store, added, web.cookie)).resolves.toBe(
        'OAUTH_STATE_INVALID',
      );
    });

    it('rejects a signed redirect that left the allow-list', async () => {
      const { state, cookie } = begin(nativeStore(), CHALLENGE, {
        redirect: NATIVE,
      });
      await expect(
        finish(new SignedOAuthStateStore(SECRET), state, cookie),
      ).resolves.toBe('OAUTH_STATE_INVALID');
    });
  });
});
