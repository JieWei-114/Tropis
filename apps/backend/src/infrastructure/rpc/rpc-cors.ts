import type { IncomingMessage, ServerResponse } from 'http';
import type { Http2ServerRequest, Http2ServerResponse } from 'http2';
import { cors } from '@connectrpc/connect';

export type RpcRequest = IncomingMessage | Http2ServerRequest;
export type RpcResponse = ServerResponse | Http2ServerResponse;
export type RpcRequestHandler = (req: RpcRequest, res: RpcResponse) => void;

/** Headers the browser clients send beyond what the Connect protocols need. */
const APP_REQUEST_HEADERS = [
  'Authorization',
  'X-Request-Id',
  'X-Tenant-Id',
  'Traceparent',
  'Tracestate',
];
/** Headers the browser clients may read beyond the Connect protocol ones. */
const APP_EXPOSED_HEADERS = ['X-Request-Id', 'Trace-Id'];

/** Browsers cap preflight caching at two hours; longer values are ignored. */
const PREFLIGHT_MAX_AGE_S = 7200;

const ALLOW_METHODS = cors.allowedMethods.join(', ');
const ALLOW_HEADERS = [...cors.allowedHeaders, ...APP_REQUEST_HEADERS].join(
  ', ',
);
const EXPOSE_HEADERS = [...cors.exposedHeaders, ...APP_EXPOSED_HEADERS].join(
  ', ',
);

/**
 * CORS for the public listener, which browsers call directly with the Connect
 * and gRPC-Web protocols. Only pinned origins are echoed back (a wildcard
 * would let any page a signed-in user visits script calls and read the
 * responses); a request from any other origin gets no CORS headers, so the
 * browser blocks it. Credentials mode stays off: the clients authenticate
 * with a bearer header, never cookies.
 */
export function withCors(
  allowedOrigins: readonly string[],
  handler: RpcRequestHandler,
): RpcRequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res) => {
    const origin = req.headers.origin;
    const allowedOrigin =
      typeof origin === 'string' && allowed.has(origin) ? origin : undefined;
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
    }

    const isPreflight =
      req.method === 'OPTIONS' &&
      req.headers['access-control-request-method'] !== undefined;
    if (isPreflight) {
      if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
        res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
        res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_S));
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    if (allowedOrigin) {
      res.setHeader('Access-Control-Expose-Headers', EXPOSE_HEADERS);
    }
    handler(req, res);
  };
}
