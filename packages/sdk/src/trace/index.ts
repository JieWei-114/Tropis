/**
 * W3C Trace Context propagation (https://www.w3.org/TR/trace-context/).
 * Every RPC and REST call carries a `traceparent` header, so the backend
 * joins the caller's trace instead of starting an unrelated one. A caller
 * with its own tracer (e.g. OpenTelemetry web) passes a TraceparentProvider
 * that returns the active span's header; otherwise, or when the provider
 * returns nothing valid, each call starts a fresh sampled trace.
 */

import { HEADERS } from '@tropis/shared';

export const TRACEPARENT_HEADER = HEADERS.TRACEPARENT;

/** Returns the active `traceparent` header value, or nothing when none is active. */
export type TraceparentProvider = () => string | null | undefined;

const TRACEPARENT =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function isValidTraceparent(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = TRACEPARENT.exec(value);
  if (!match) return false;
  const [, version, traceId, parentId] = match;
  return version !== 'ff' && !/^0+$/.test(traceId!) && !/^0+$/.test(parentId!);
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  do {
    globalThis.crypto.getRandomValues(buf);
  } while (buf.every((b) => b === 0));
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A new sampled root: version 00, random trace id and parent id, flags 01. */
export function generateTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

/** The provider's value when it is a valid header, else a fresh trace. */
export function resolveTraceparent(provider?: TraceparentProvider): string {
  let active: string | null | undefined;
  try {
    active = provider?.();
  } catch {
    active = undefined;
  }
  return isValidTraceparent(active) ? active : generateTraceparent();
}
