import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import { ErrorInfoSchema } from '../../../gen/google/rpc/error_details_pb';
import { AppError } from '../../../common/errors';
import { SigningService } from '../../../gen/signing/v1/signing_pb';
import { InprocessSigningAdapter } from '../adapters/inprocess/inprocess-signing.adapter';
import { NativeSigningAdapter } from '../adapters/native/native-signing.adapter';
import { buildCanonicalString, computeSignature } from '../signing.canonical';
import type { SigningPort } from '../signing.port';
import { describeSigningPort, SIGNING_VECTOR } from './signing.conformance';

describeSigningPort('inprocess', { make: () => new InprocessSigningAdapter() });

/**
 * The native adapter against an in-memory SigningService that implements the
 * service contract with the same canonical builder (the real Rust service
 * runs in test/integration/signing.conformance.spec.ts).
 */
describeSigningPort('native (in-memory transport)', {
  make: () => {
    const keys: Record<string, string> = {
      [SIGNING_VECTOR.keyId]: SIGNING_VECTOR.secret,
    };
    const sign = (r: {
      method: string;
      path: string;
      timestamp: bigint;
      nonce: string;
      body: Uint8Array;
      keyId: string;
    }) =>
      computeSignature(
        keys[r.keyId] ?? '',
        buildCanonicalString(
          r.method,
          r.path,
          String(r.timestamp),
          r.nonce,
          Buffer.from(r.body),
        ),
      );
    const transport = createRouterTransport(({ service }) => {
      service(SigningService, {
        computeSignature: (req) => ({ signature: sign(req) }),
        verifySignature: (req) => {
          if (!keys[req.keyId])
            return { valid: false, reason: 'API_KEY_UNKNOWN' };
          const valid = sign(req) === req.signature;
          return { valid, reason: valid ? 'OK' : 'SIGNATURE_INVALID' };
        },
      });
    });
    return new NativeSigningAdapter('http://unused', transport);
  },
});

describe('NativeSigningAdapter', () => {
  it('does not send the secret: the service resolves it from keyId', async () => {
    let seen: Record<string, unknown> | undefined;
    const transport = createRouterTransport(({ service }) => {
      service(SigningService, {
        computeSignature: (req) => {
          seen = { ...req };
          return { signature: 'abc' };
        },
        verifySignature: () => ({ valid: true, reason: 'OK' }),
      });
    });
    const adapter: SigningPort = new NativeSigningAdapter(
      'http://unused',
      transport,
    );

    await adapter.sign(
      {
        method: 'POST',
        path: '/p',
        timestamp: '1700000000',
        nonce: 'n',
        body: Buffer.from('x'),
        keyId: 'svc',
      },
      'client-side-secret',
    );

    expect(seen).toMatchObject({ keyId: 'svc', timestamp: 1700000000n });
    expect(
      JSON.stringify(seen, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    ).not.toContain('client-side-secret');
  });

  it('reports down when the service is unreachable', async () => {
    const adapter = new NativeSigningAdapter('http://127.0.0.1:1');
    await expect(adapter.health()).resolves.toMatchObject({
      status: 'down',
      adapter: 'native',
    });
  });

  it('rejects a timestamp that is not integer seconds', async () => {
    const adapter: SigningPort = new NativeSigningAdapter('http://127.0.0.1:1');
    await expect(
      adapter.sign(
        {
          method: 'POST',
          path: '/p',
          timestamp: '1.5',
          nonce: 'n',
          body: Buffer.alloc(0),
          keyId: 'k',
        },
        's',
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('NativeSigningAdapter error mapping', () => {
  const input = {
    method: 'POST',
    path: '/p',
    timestamp: '1700000000',
    nonce: 'n',
    body: Buffer.alloc(0),
    keyId: 'svc',
  };

  const adapterAnswering = (
    verifySignature: () => { valid: boolean; reason: string },
    computeSignature: () => { signature: string } = () => ({
      signature: 'abc',
    }),
  ): SigningPort =>
    new NativeSigningAdapter(
      'http://unused',
      createRouterTransport(({ service }) => {
        service(SigningService, { computeSignature, verifySignature });
      }),
    );

  const codeOf = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    return (err as AppError).code;
  };

  it.each(['SIGNATURE_EXPIRED', 'API_KEY_UNKNOWN'])(
    'surfaces the %s reason as its catalog code',
    async (reason) => {
      const adapter = adapterAnswering(() => ({ valid: false, reason }));
      await expect(codeOf(adapter.verify(input, 'sig', 's'))).resolves.toBe(
        reason,
      );
    },
  );

  it('answers false for SIGNATURE_INVALID and true for OK', async () => {
    await expect(
      adapterAnswering(() => ({
        valid: false,
        reason: 'SIGNATURE_INVALID',
      })).verify(input, 'sig', 's'),
    ).resolves.toBe(false);
    await expect(
      adapterAnswering(() => ({ valid: true, reason: 'OK' })).verify(
        input,
        'sig',
        's',
      ),
    ).resolves.toBe(true);
  });

  it('maps the ErrorInfo reason of a service error to its catalog code', async () => {
    const adapter = adapterAnswering(
      () => ({ valid: true, reason: 'OK' }),
      () => {
        throw new ConnectError(
          'The API key is not recognised.',
          Code.Unauthenticated,
          undefined,
          [
            {
              desc: ErrorInfoSchema,
              value: { reason: 'API_KEY_UNKNOWN', domain: 'tropis' },
            },
          ],
        );
      },
    );
    await expect(codeOf(adapter.sign(input, 's'))).resolves.toBe(
      'API_KEY_UNKNOWN',
    );
  });

  it.each([
    [Code.Unavailable, 'SERVICE_UNAVAILABLE'],
    [Code.DeadlineExceeded, 'GATEWAY_TIMEOUT'],
    [Code.Internal, 'BAD_GATEWAY'],
    [Code.NotFound, 'BAD_GATEWAY'],
  ])(
    'never surfaces a bare service error as INTERNAL (%s)',
    async (code, expected) => {
      const adapter = adapterAnswering(() => {
        throw new ConnectError('boom', code);
      });
      await expect(codeOf(adapter.verify(input, 'sig', 's'))).resolves.toBe(
        expected,
      );
    },
  );

  it('reports an unreachable service as SERVICE_UNAVAILABLE', async () => {
    const adapter: SigningPort = new NativeSigningAdapter('http://127.0.0.1:1');
    await expect(codeOf(adapter.sign(input, 's'))).resolves.toBe(
      'SERVICE_UNAVAILABLE',
    );
  });
});
