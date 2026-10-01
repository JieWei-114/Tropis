import { defineKey } from '../../../common/keyspace';
import { CapabilityDisabledError } from '../../capability';
import { DisabledDedupAdapter } from '../adapters/disabled/disabled-dedup.adapter';
import type { DedupPort } from '../dedup.port';
import { describeDedupPort } from './dedup.conformance';
import { InMemoryDedupAdapter } from './in-memory-dedup.adapter';

describeDedupPort('in-memory fake', { make: () => new InMemoryDedupAdapter() });

describe('DisabledDedupAdapter', () => {
  it('throws CapabilityDisabledError from every method', async () => {
    const dedup: DedupPort = new DisabledDedupAdapter();
    const key = defineKey({
      capability: 'dedup',
      module: 'test',
      name: 'processed-event',
      version: 'v1',
    }).global('1');
    for (const call of [
      () => dedup.claim(key, 1),
      () => dedup.extend(key, 1),
      () => dedup.release(key),
      () => dedup.claimMany([key], 1),
      () => dedup.extendMany([key], 1),
      () => dedup.releaseMany([key]),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(CapabilityDisabledError);
    }
    expect((await dedup.health()).status).toBe('disabled');
  });
});
