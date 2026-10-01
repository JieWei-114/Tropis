import { describe, expect, it } from 'vitest';
import {
  generateTraceparent,
  isValidTraceparent,
  resolveTraceparent,
} from '../index';

const ACTIVE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('trace context', () => {
  it('generates a valid sampled root with a new trace id each time', () => {
    const a = generateTraceparent();
    const b = generateTraceparent();
    expect(isValidTraceparent(a)).toBe(true);
    expect(a).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(a.split('-')[1]).not.toBe(b.split('-')[1]);
  });

  it.each([
    ['all-zero trace id', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
    [
      'all-zero parent id',
      `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`,
    ],
    ['version ff', 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['uppercase hex', ACTIVE.toUpperCase()],
    ['garbage', 'not-a-traceparent'],
  ])('rejects %s', (_label, value) => {
    expect(isValidTraceparent(value)).toBe(false);
  });

  it('uses the active traceparent from the provider', () => {
    expect(resolveTraceparent(() => ACTIVE)).toBe(ACTIVE);
  });

  it('starts a fresh trace when the provider returns nothing, garbage or throws', () => {
    for (const provider of [
      () => null,
      () => 'bogus',
      () => {
        throw new Error('tracer down');
      },
      undefined,
    ]) {
      const value = resolveTraceparent(provider);
      expect(isValidTraceparent(value)).toBe(true);
      expect(value).not.toBe(ACTIVE);
    }
  });
});
