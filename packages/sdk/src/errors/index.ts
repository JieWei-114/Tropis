/**
 * Error normalization — converts ConnectError / fetch errors / unknown
 * throwables into a consistent ApiError shape for the UI.
 */

import { Code, ConnectError } from '@connectrpc/connect';

export interface ApiError {
  code: number;
  message: string;
  isAuth: boolean;
  isNetwork: boolean;
}

/**
 * Normalize any thrown value (ConnectError, fetch Error, unknown) into a
 * consistent ApiError shape. Use this in catch blocks instead of casting
 * the raw error, so the UI always has a human-readable message and a code.
 */
export function parseApiError(err: unknown): ApiError {
  if (err instanceof ConnectError) {
    return {
      code: err.code,
      message: grpcMessage(err.code, err.rawMessage),
      isAuth:
        err.code === Code.Unauthenticated || err.code === Code.PermissionDenied,
      isNetwork: err.code === Code.Unavailable,
    };
  }

  if (err instanceof Error) {
    const isNetwork =
      err.message.includes('Failed to fetch') ||
      err.message.includes('NetworkError') ||
      err.message.includes('net::');
    return {
      code: -1,
      message: isNetwork
        ? 'Network error — check your connection'
        : err.message,
      isAuth: false,
      isNetwork,
    };
  }

  return {
    code: -1,
    message: 'An unexpected error occurred',
    isAuth: false,
    isNetwork: false,
  };
}

/** Map gRPC status codes to user-friendly messages. */
function grpcMessage(code: number, fallback: string): string {
  const map: Record<number, string> = {
    1: 'Request was cancelled',
    2: 'An internal error occurred',
    3: 'Invalid input — check your data',
    4: 'Request timed out',
    5: 'Not found',
    6: 'Already exists',
    7: 'Permission denied',
    8: 'Too many requests — please slow down',
    14: 'Server unreachable — check your connection',
    16: 'Not authenticated — please log in',
  };
  return map[code] ?? fallback;
}
