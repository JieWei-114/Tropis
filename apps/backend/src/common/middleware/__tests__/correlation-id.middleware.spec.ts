import type { Request, Response } from 'express';
import {
  CorrelationIdMiddleware,
  getRequestId,
  runWithRequestId,
} from '../correlation-id.middleware';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

describe('correlation id', () => {
  const run = (headers: Record<string, string>) => {
    const setHeader = jest.fn();
    let inside = '';
    new CorrelationIdMiddleware().use(
      { headers } as unknown as Request,
      { setHeader } as unknown as Response,
      () => {
        inside = getRequestId();
      },
    );
    return { setHeader, inside };
  };

  it('falls back outside any request', () => {
    expect(getRequestId()).toBe('no-request-context');
  });

  it('runWithRequestId exposes the id to everything the callback awaits', async () => {
    const seen = await runWithRequestId('rpc-123', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return getRequestId();
    });

    expect(seen).toBe('rpc-123');
    expect(getRequestId()).toBe('no-request-context');
  });

  it('runWithRequestId returns the callback result', () => {
    expect(runWithRequestId('id', () => 42)).toBe(42);
  });

  it('uses the incoming traceparent trace id as the request id', () => {
    const { setHeader, inside } = run({ traceparent: TRACEPARENT });
    expect(setHeader).toHaveBeenCalledWith('x-request-id', TRACE_ID);
    expect(inside).toBe(TRACE_ID);
  });

  it('never adopts an incoming x-request-id as the id', () => {
    const { setHeader, inside } = run({
      traceparent: TRACEPARENT,
      'x-request-id': 'http-1',
    });
    expect(inside).toBe(TRACE_ID);
    expect(setHeader).not.toHaveBeenCalledWith('x-request-id', 'http-1');
  });

  it('mints a W3C trace id when the request carries no trace', () => {
    const { setHeader, inside } = run({ 'x-request-id': 'http-1' });
    expect(inside).toMatch(/^[0-9a-f]{32}$/);
    expect(setHeader).toHaveBeenCalledWith('x-request-id', inside);
  });

  it('ignores a malformed traceparent', () => {
    const { inside } = run({
      traceparent: `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`,
    });
    expect(inside).toMatch(/^[0-9a-f]{32}$/);
    expect(inside).not.toBe('0'.repeat(32));
  });
});
