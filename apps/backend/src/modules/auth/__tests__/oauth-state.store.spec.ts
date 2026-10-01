import type { Request } from 'express';
import {
  SignedOAuthStateStore,
  oauthChallengeOf,
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

function begin(store: SignedOAuthStateStore, challenge: unknown = CHALLENGE) {
  const b = browser();
  let state = '';
  store.store(b.request(undefined, { challenge }), {}, (err, s) => {
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
});
