import {
  bullBoardEnabled,
  bullBoardImports,
  bullBoardProviders,
  loopbackOnly,
} from '../adapters/bullmq/bull-board';

describe('Bull Board', () => {
  it('is mounted only in the local `all` role outside production', () => {
    expect(bullBoardEnabled('development', 'all')).toBe(true);
    expect(bullBoardEnabled(undefined, undefined)).toBe(true);
    expect(bullBoardEnabled('production', 'all')).toBe(false);
  });

  // Reproduces the gap: outside production the dashboard was mounted,
  // unauthenticated, on every role's public HTTP port.
  it.each(['public', 'private', 'worker', 'scheduler'])(
    'is not mounted in the %s role',
    (role) => {
      expect(bullBoardEnabled('development', role)).toBe(false);
    },
  );

  it('imports and provides nothing when disabled', () => {
    expect(bullBoardImports(false)).toEqual([]);
    expect(bullBoardProviders(false)).toEqual([]);
    expect(bullBoardImports(true)).toHaveLength(1);
    expect(bullBoardProviders(true)).toHaveLength(1);
  });

  it('answers only direct loopback requests', () => {
    const run = (
      remoteAddress: string,
      headers: Record<string, string> = {},
    ) => {
      const next = jest.fn();
      const res = {
        status: jest.fn<unknown, [number]>().mockReturnThis(),
        end: jest.fn(),
      };
      loopbackOnly(
        { socket: { remoteAddress }, headers } as never,
        res as never,
        next,
      );
      return next.mock.calls.length > 0 ? 'next' : res.status.mock.calls[0][0];
    };
    expect(run('127.0.0.1')).toBe('next');
    expect(run('::1')).toBe('next');
    expect(run('10.0.0.5')).toBe(404);
    expect(run('127.0.0.1', { 'x-forwarded-for': '203.0.113.1' })).toBe(404);
  });
});
