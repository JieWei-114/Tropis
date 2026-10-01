import {
  Code,
  ConnectError,
  createClient,
  type Client,
  type Transport,
} from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { ERROR_DOMAIN, isErrorCode, type ErrorCode } from '@tropis/shared';
import { AppError } from '../../../../common/errors';
import { ErrorInfoSchema } from '../../../../gen/google/rpc/error_details_pb';
import { SigningService } from '../../../../gen/signing/v1/signing_pb';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import type { SignatureInput, SigningPort } from '../../signing.port';

const HEALTH_TIMEOUT_MS = 2_000;
const CALL_TIMEOUT_MS = 5_000;

/**
 * SigningPort over the native signing service (services/rust/signing,
 * tropis.signing.v1.SigningService) via gRPC.
 *
 * The service resolves the secret from `keyId` in its own API_KEYS, so the
 * `secret` argument is not sent: both processes must be configured with the
 * same keys. The service also re-checks the ±300 s timestamp window.
 *
 * Errors: a verification `reason` other than OK and SIGNATURE_INVALID (the
 * clock window, a key the service does not hold) is thrown as the AppError of
 * that catalog code, and an RPC failure as the catalog code of its ErrorInfo
 * reason, else as SERVICE_UNAVAILABLE / GATEWAY_TIMEOUT / BAD_GATEWAY. A raw
 * ConnectError never escapes, so it never reaches a caller as INTERNAL.
 */
export class NativeSigningAdapter implements SigningPort {
  private readonly client: Client<typeof SigningService>;

  constructor(baseUrl: string, transport?: Transport) {
    this.client = createClient(
      SigningService,
      transport ?? createGrpcTransport({ baseUrl }),
    );
  }

  async sign(input: SignatureInput): Promise<string> {
    const res = await call(() =>
      this.client.computeSignature(
        {
          method: input.method,
          path: input.path,
          timestamp: toUnixSeconds(input.timestamp),
          nonce: input.nonce,
          body: new Uint8Array(input.body),
          keyId: input.keyId,
        },
        { timeoutMs: CALL_TIMEOUT_MS },
      ),
    );
    return res.signature;
  }

  async verify(input: SignatureInput, signature: string): Promise<boolean> {
    const res = await call(() =>
      this.client.verifySignature(
        {
          method: input.method,
          path: input.path,
          timestamp: toUnixSeconds(input.timestamp),
          nonce: input.nonce,
          body: new Uint8Array(input.body),
          keyId: input.keyId,
          signature,
        },
        { timeoutMs: CALL_TIMEOUT_MS },
      ),
    );
    if (res.valid) return true;
    if (res.reason !== REASON_INVALID && isErrorCode(res.reason)) {
      throw new AppError(res.reason);
    }
    return false;
  }

  /** Any answer (even `valid: false`) proves the service is serving. */
  health(): Promise<CapabilityHealth> {
    return probeCapability('native', () =>
      this.client.verifySignature({}, { timeoutMs: HEALTH_TIMEOUT_MS }),
    );
  }
}

const REASON_INVALID = 'SIGNATURE_INVALID';

/** Runs one RPC, turning any failure into the AppError of a catalog code. */
async function call<T>(rpc: () => Promise<T>): Promise<T> {
  try {
    return await rpc();
  } catch (err) {
    if (err instanceof RangeError) throw err;
    throw toAppError(err);
  }
}

function toAppError(err: unknown): AppError {
  const connect = ConnectError.from(err);
  const reason = connect
    .findDetails(ErrorInfoSchema)
    .find((d) => d.domain === ERROR_DOMAIN)?.reason;
  if (reason && isErrorCode(reason)) {
    return new AppError(reason, { cause: err });
  }
  return new AppError(fallbackCode(connect), { cause: err });
}

/** Socket errors connect-node reports as Internal, though nothing answered. */
const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
]);

function isUnreachable(err: ConnectError): boolean {
  const cause = err.cause as { code?: unknown } | undefined;
  return typeof cause?.code === 'string' && UNREACHABLE.has(cause.code);
}

function fallbackCode(err: ConnectError): ErrorCode {
  const { code } = err;
  if (code === Code.Unavailable || isUnreachable(err)) {
    return 'SERVICE_UNAVAILABLE';
  }
  if (code === Code.DeadlineExceeded) return 'GATEWAY_TIMEOUT';
  return 'BAD_GATEWAY';
}

function toUnixSeconds(timestamp: string): bigint {
  if (!/^-?\d+$/.test(timestamp)) {
    throw new RangeError(
      `Signing timestamp must be integer seconds, got ${timestamp}`,
    );
  }
  return BigInt(timestamp);
}
