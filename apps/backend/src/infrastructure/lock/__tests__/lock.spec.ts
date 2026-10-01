import { defineKey } from '../../../common/keyspace';
import { CapabilityDisabledError } from '../../capability';
import { DisabledLockAdapter } from '../adapters/disabled/disabled-lock.adapter';
import type { LockPort } from '../lock.port';
import { InMemoryLockAdapter } from './in-memory-lock.adapter';
import { describeLockPort } from './lock.conformance';

describeLockPort('in-memory fake', {
  make: () => new InMemoryLockAdapter(),
});

describe('DisabledLockAdapter', () => {
  it('throws CapabilityDisabledError and reports disabled', async () => {
    const lock: LockPort = new DisabledLockAdapter();
    const key = defineKey({
      capability: 'lock',
      module: 'test',
      name: 'job',
      version: 'v1',
    }).global();
    await expect(lock.acquire(key, 1_000)).rejects.toBeInstanceOf(
      CapabilityDisabledError,
    );
    expect((await lock.health()).status).toBe('disabled');
    const raw = 'tropis:test:global:lock:test:job:v1';
    // @ts-expect-error a raw string cannot address a lock
    void lock.acquire(raw, 1).catch(() => undefined);
  });
});
