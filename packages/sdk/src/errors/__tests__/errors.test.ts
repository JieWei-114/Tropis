import { afterEach, describe, expect, it, vi } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { createSdk } from '../../client/index';
import {
  BadRequestSchema,
  ErrorInfoSchema,
} from '../../gen/google/rpc/error_details_pb';
import {
  ApiRequestError,
  parseApiError,
  readApiError,
  type ProblemDetails,
} from '../index';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/=+$/, '');

/** A Connect-protocol unary error response, as the backend writes it. */
function connectErrorResponse(
  status: number,
  code: string,
  message: string,
  details: Array<{ type: string; value: Uint8Array }>,
) {
  return new Response(
    JSON.stringify({
      code,
      message,
      details: details.map((d) => ({ type: d.type, value: b64(d.value) })),
    }),
    {
      status,
      headers: { 'content-type': 'application/json', 'trace-id': TRACE_ID },
    },
  );
}

describe('parseApiError: Connect errors from the wire', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads ErrorInfo, BadRequest and the trace-id header', async () => {
    const info = toBinary(
      ErrorInfoSchema,
      create(ErrorInfoSchema, {
        reason: 'VALIDATION_FAILED',
        domain: 'tropis',
        metadata: { retryable: 'false' },
      }),
    );
    const bad = toBinary(
      BadRequestSchema,
      create(BadRequestSchema, {
        fieldViolations: [
          { field: 'email', description: 'email must be an email' },
        ],
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        connectErrorResponse(
          400,
          'invalid_argument',
          'One or more fields are invalid.',
          [
            { type: 'google.rpc.ErrorInfo', value: info },
            { type: 'google.rpc.BadRequest', value: bad },
          ],
        ),
      ),
    );
    const sdk = createSdk({ baseUrl: 'http://localhost:50051' });
    const err = await sdk.users.create({}).catch((e: unknown) => e);

    expect(parseApiError(err)).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'One or more fields are invalid.',
      status: 400,
      rpcCode: Code.InvalidArgument,
      retryable: false,
      fieldErrors: [{ field: 'email', description: 'email must be an email' }],
      traceId: TRACE_ID,
      isAuth: false,
      isNetwork: false,
    });
  });
});

describe('parseApiError: Connect errors', () => {
  const withInfo = (
    code: Code,
    message: string,
    reason: string,
    retryable?: string,
  ) =>
    new ConnectError(message, code, { 'trace-id': TRACE_ID }, [
      {
        desc: ErrorInfoSchema,
        value: {
          reason,
          domain: 'tropis',
          metadata: retryable ? { retryable } : {},
        },
      },
    ]);

  it('uses the catalog code and the server message', () => {
    const e = parseApiError(
      withInfo(Code.NotFound, 'The user was not found.', 'USER_NOT_FOUND'),
    );
    expect(e).toMatchObject({
      code: 'USER_NOT_FOUND',
      message: 'The user was not found.',
      status: 404,
      retryable: false,
      traceId: TRACE_ID,
      isAuth: false,
      isNetwork: false,
    });
  });

  it('flags auth failures and signing codes', () => {
    expect(
      parseApiError(withInfo(Code.Unauthenticated, 'x', 'SIGNATURE_EXPIRED'))
        .isAuth,
    ).toBe(true);
    expect(
      parseApiError(new ConnectError('x', Code.PermissionDenied)).isAuth,
    ).toBe(true);
  });

  it('prefers the retryable flag the server sent', () => {
    expect(
      parseApiError(
        withInfo(Code.Unavailable, 'off', 'CAPABILITY_DISABLED', 'false'),
      ).retryable,
    ).toBe(false);
    expect(
      parseApiError(
        withInfo(Code.Unavailable, 'busy', 'SERVICE_UNAVAILABLE', 'true'),
      ),
    ).toMatchObject({ retryable: true, isNetwork: false });
  });

  it('falls back to the transport code without ErrorInfo', () => {
    expect(
      parseApiError(new ConnectError('boom', Code.AlreadyExists)),
    ).toMatchObject({
      code: 'CONFLICT',
      message: 'The request conflicts with the current state.',
      status: 409,
      rpcCode: Code.AlreadyExists,
    });
    expect(
      parseApiError(new ConnectError('fetch failed', Code.Unavailable)),
    ).toMatchObject({
      code: 'NETWORK_ERROR',
      isNetwork: true,
      retryable: true,
    });
  });

  it('ignores ErrorInfo from another domain', () => {
    const foreign = new ConnectError('x', Code.NotFound, undefined, [
      {
        desc: ErrorInfoSchema,
        value: { reason: 'SOMETHING', domain: 'other.dev' },
      },
    ]);
    expect(parseApiError(foreign).code).toBe('NOT_FOUND');
  });
});

describe('parseApiError: RFC 9457 problems', () => {
  const problem: ProblemDetails = {
    type: 'https://errors.tropis.dev/user-already-exists',
    title: 'A user with this email already exists.',
    status: 409,
    instance: '/api/users',
    code: 'USER_ALREADY_EXISTS',
    traceId: TRACE_ID,
    retryable: false,
  };

  it('reads a problem body thrown as ApiRequestError', () => {
    expect(parseApiError(new ApiRequestError(409, problem))).toEqual({
      code: 'USER_ALREADY_EXISTS',
      message: 'A user with this email already exists.',
      status: 409,
      retryable: false,
      fieldErrors: [],
      traceId: TRACE_ID,
      isAuth: false,
      isNetwork: false,
    });
  });

  it('prefers detail, maps errors and recovers the code from type', () => {
    const e = parseApiError({
      type: 'https://errors.tropis.dev/validation-failed',
      title: 'One or more fields are invalid.',
      status: 400,
      detail: 'Check the form.',
      errors: [{ field: 'name', description: 'name is too short' }],
    });
    expect(e).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Check the form.',
      fieldErrors: [{ field: 'name', description: 'name is too short' }],
    });
  });

  it('builds an ApiRequestError from a fetch Response', async () => {
    const res = new Response(
      JSON.stringify({ ...problem, status: 401, code: 'UNAUTHORIZED' }),
      {
        status: 401,
        headers: {
          'content-type': 'application/problem+json',
          'x-request-id': TRACE_ID,
        },
      },
    );
    const e = parseApiError(await readApiError(res));
    expect(e).toMatchObject({
      code: 'UNAUTHORIZED',
      isAuth: true,
      traceId: TRACE_ID,
    });
  });

  it('handles a non-problem body by status', async () => {
    const e = parseApiError(
      await readApiError(new Response('<html>', { status: 503 })),
    );
    expect(e).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
      retryable: true,
    });
  });
});

describe('parseApiError: other values', () => {
  it('recognises network failures', () => {
    expect(parseApiError(new TypeError('Failed to fetch'))).toMatchObject({
      code: 'NETWORK_ERROR',
      isNetwork: true,
      retryable: true,
      status: 0,
    });
  });

  it('keeps a plain error message and handles unknown values', () => {
    expect(parseApiError(new Error('bad state')).message).toBe('bad state');
    expect(parseApiError(42)).toMatchObject({
      code: 'INTERNAL',
      message: 'An unexpected error occurred',
    });
  });
});

describe('parseApiError: catalog mapping', () => {
  it.each([
    [405, 'METHOD_NOT_ALLOWED', false],
    [413, 'PAYLOAD_TOO_LARGE', false],
    [415, 'UNSUPPORTED_MEDIA_TYPE', false],
    [422, 'UNPROCESSABLE', false],
    [499, 'CANCELLED', false],
    [501, 'NOT_IMPLEMENTED', false],
    [502, 'BAD_GATEWAY', true],
    [504, 'GATEWAY_TIMEOUT', true],
    [418, 'BAD_REQUEST', false],
  ])('maps a bare %i to %s', async (status, code, retryable) => {
    const e = parseApiError(
      await readApiError(new Response('', { status: status as number })),
    );
    expect(e).toMatchObject({ code, status, retryable });
  });

  it('takes status and retryability from the catalog entry of the reason', () => {
    const e = parseApiError(
      new ConnectError('last admin', Code.FailedPrecondition, undefined, [
        {
          desc: ErrorInfoSchema,
          value: { reason: 'USER_LAST_ADMIN', domain: 'tropis' },
        },
      ]),
    );
    expect(e).toMatchObject({
      code: 'USER_LAST_ADMIN',
      status: 409,
      retryable: false,
    });
  });

  it('treats a problem without retryable by its catalog entry', () => {
    expect(
      parseApiError({
        type: 'https://errors.tropis.dev/aborted',
        title: 'aborted',
        status: 409,
      }),
    ).toMatchObject({ code: 'ABORTED', retryable: true });
  });

  it('flags every 401 and 403 catalog code as an auth failure', () => {
    for (const reason of ['AUTH_TOKEN_REVOKED', 'TENANT_MISMATCH']) {
      expect(
        parseApiError(
          new ConnectError('x', Code.Unknown, undefined, [
            { desc: ErrorInfoSchema, value: { reason, domain: 'tropis' } },
          ]),
        ).isAuth,
      ).toBe(true);
    }
  });
});
