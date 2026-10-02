import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shared = require('../../../dist/index.js');
const {
  ERROR_CATALOG,
  ERROR_CODES,
  RPC_CODES,
  errorCodeForHttpStatus,
  errorCodeForRpcCode,
  errorTypeUri,
  errorCodeFromTypeUri,
  isErrorCode,
  listErrorDefinitions,
} = shared;

const entries = listErrorDefinitions();

test('every code is UPPER_SNAKE and keyed by itself', () => {
  for (const e of entries) {
    assert.match(e.code, /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/, e.code);
    assert.equal(ERROR_CATALOG[e.code], e);
    assert.equal(ERROR_CODES[e.code], e.code);
  }
});

test('every entry is complete and consistent', () => {
  for (const e of entries) {
    assert.ok(e.httpStatus >= 400 && e.httpStatus < 600, e.code);
    assert.ok(e.rpcCode in RPC_CODES, `${e.code} rpcCode ${e.rpcCode}`);
    assert.equal(typeof e.retryable, 'boolean', e.code);
    assert.ok(e.publicMessage.length > 0, e.code);
    assert.match(
      e.publicMessage,
      /^[A-Z].*\.$/,
      `${e.code} message is a sentence`,
    );
    assert.ok(
      !/[\u0080-￿]/.test(e.publicMessage),
      `${e.code} is ASCII English`,
    );
    if (e.deprecated)
      assert.ok(isErrorCode(e.replacedBy), `${e.code} replacedBy`);
    if (e.domain !== undefined) assert.match(e.domain, /^[a-z][a-z-]*$/);
  }
});

test('domain codes carry their module prefix or a signing/auth domain', () => {
  for (const e of entries.filter(
    (x) => x.domain === 'user' || x.domain === 'analytics',
  )) {
    assert.ok(e.code.startsWith(`${e.domain.toUpperCase()}_`), e.code);
  }
});

test('every code that business code used before the catalog still resolves', () => {
  for (const code of [
    'BAD_REQUEST',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'NOT_FOUND',
    'CONFLICT',
    'UNPROCESSABLE',
    'RATE_LIMITED',
    'INTERNAL_ERROR',
    'BAD_GATEWAY',
    'SERVICE_UNAVAILABLE',
    'HTTP_ERROR',
    'USER_NOT_FOUND',
    'USER_ALREADY_EXISTS',
    'USER_LAST_ADMIN',
    'OAUTH_NOT_CONFIGURED',
    'API_KEY_UNKNOWN',
    'SIGNATURE_INVALID',
    'SIGNATURE_EXPIRED',
    'NONCE_REUSED',
  ]) {
    assert.ok(isErrorCode(code), code);
  }
});

test('generic codes by HTTP status', () => {
  assert.equal(errorCodeForHttpStatus(404), 'NOT_FOUND');
  assert.equal(errorCodeForHttpStatus(500), 'INTERNAL');
  assert.equal(errorCodeForHttpStatus(418), 'BAD_REQUEST');
  assert.equal(errorCodeForHttpStatus(599), 'INTERNAL');
  for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
    assert.equal(
      ERROR_CATALOG[errorCodeForHttpStatus(status)].httpStatus,
      status,
      String(status),
    );
  }
});

test('generic codes by RPC code map back to the same RPC code', () => {
  for (const [name, num] of Object.entries(RPC_CODES)) {
    const code = errorCodeForRpcCode(name);
    assert.equal(errorCodeForRpcCode(num), code);
    if (!['Unknown', 'OutOfRange', 'DataLoss'].includes(name)) {
      assert.equal(ERROR_CATALOG[code].rpcCode, name, name);
    }
  }
  assert.equal(errorCodeForRpcCode(99), 'INTERNAL');
});

test('problem type URIs round-trip for every code', () => {
  assert.equal(
    errorTypeUri('USER_NOT_FOUND'),
    'https://errors.tropis.dev/user-not-found',
  );
  for (const e of entries) {
    assert.equal(errorCodeFromTypeUri(errorTypeUri(e.code)), e.code);
  }
  assert.equal(errorCodeFromTypeUri('about:blank'), undefined);
  assert.equal(
    errorCodeFromTypeUri('https://errors.tropis.dev/nope'),
    undefined,
  );
});

test('retryable follows the transport semantics', () => {
  for (const e of entries) {
    if (['Unavailable', 'DeadlineExceeded', 'Aborted'].includes(e.rpcCode)) {
      assert.equal(e.retryable, true, e.code);
    }
    if (
      [
        'InvalidArgument',
        'NotFound',
        'PermissionDenied',
        'Unauthenticated',
      ].includes(e.rpcCode)
    ) {
      assert.equal(e.retryable, false, e.code);
    }
  }
});

test('a disabled capability is not implemented here, not an outage', () => {
  const e = ERROR_CATALOG.CAPABILITY_DISABLED;
  assert.equal(e.httpStatus, 501);
  assert.equal(e.rpcCode, 'Unimplemented');
  assert.equal(e.retryable, false);
});

test('auth session and account-linking codes', () => {
  const expected = {
    OAUTH_ACCOUNT_EXISTS: [409, 'AlreadyExists', false],
    AUTH_CSRF_REJECTED: [403, 'PermissionDenied', false],
    AUTH_CURRENT_PASSWORD_REQUIRED: [403, 'PermissionDenied', false],
    SERVICE_UNAVAILABLE: [503, 'Unavailable', true],
  };
  for (const [code, [status, rpc, retryable]] of Object.entries(expected)) {
    const e = ERROR_CATALOG[code];
    assert.ok(e, code);
    assert.equal(e.httpStatus, status, code);
    assert.equal(e.rpcCode, rpc, code);
    assert.equal(e.retryable, retryable, code);
  }
  assert.equal(ERROR_CATALOG.OAUTH_ACCOUNT_EXISTS.domain, 'auth');
  assert.equal(ERROR_CATALOG.AUTH_CSRF_REJECTED.domain, 'auth');
  assert.equal(ERROR_CATALOG.AUTH_CURRENT_PASSWORD_REQUIRED.domain, 'auth');
});
