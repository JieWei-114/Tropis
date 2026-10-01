import type { KvKey } from '../../../../common/keyspace';
import {
  capabilityDown,
  capabilityUp,
  type CapabilityHealth,
} from '../../../capability';
import {
  decodeKvValue,
  encodeKvValue,
  resolveKvLifetime,
} from '../../kv.codec';
import type { KvPort, KvWriteOptions } from '../../kv.port';

/** The subset of the Aerospike client this adapter uses. */
export interface AerospikeKvClient {
  put(
    key: unknown,
    bins: Record<string, unknown>,
    meta?: { ttl?: number },
  ): Promise<unknown>;
  get(key: unknown): Promise<{ bins: Record<string, unknown> }>;
  exists(key: unknown): Promise<boolean>;
  remove(key: unknown): Promise<unknown>;
  isConnected(checkTenders?: boolean): boolean;
}

type KeyConstructor = new (ns: string, set: string, key: string) => unknown;

export interface AerospikeKvOptions {
  namespace: string;
  set: string;
}

export const DEFAULT_AEROSPIKE_KV_OPTIONS: AerospikeKvOptions = {
  namespace: 'test',
  set: 'kv',
};

const VALUE_BIN = 'v';
/** Aerospike status for a missing record. */
const ERR_RECORD_NOT_FOUND = 2;
/** Aerospike TTL meaning "never expire". */
const TTL_NEVER_EXPIRE = -1;

/**
 * KvPort over Aerospike. Each value is one record keyed by the full keyspace
 * key, holding the encoded JSON in a single bin. Aerospike expires records
 * with whole-second resolution, like redis EX.
 *
 * The driver is loaded lazily because it is a native addon: loading it at
 * import would crash processes that never select this adapter on a machine
 * without the compiled binding.
 */
export class AerospikeKvAdapter implements KvPort {
  private readonly Key: KeyConstructor;

  constructor(
    private readonly client: AerospikeKvClient | null,
    private readonly options: AerospikeKvOptions = DEFAULT_AEROSPIKE_KV_OPTIONS,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.Key = (require('aerospike') as { Key: KeyConstructor }).Key;
  }

  async get<T>(key: KvKey): Promise<T | undefined> {
    try {
      const record = await this.connected().get(this.recordKey(key));
      const raw = record.bins[VALUE_BIN];
      return decodeKvValue<T>(key, typeof raw === 'string' ? raw : null);
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async set<T>(key: KvKey, value: T, options: KvWriteOptions): Promise<void> {
    const ttl = resolveKvLifetime(options);
    await this.connected().put(
      this.recordKey(key),
      { [VALUE_BIN]: encodeKvValue(value) },
      { ttl: ttl ?? TTL_NEVER_EXPIRE },
    );
  }

  async del(key: KvKey): Promise<boolean> {
    try {
      await this.connected().remove(this.recordKey(key));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  exists(key: KvKey): Promise<boolean> {
    return this.connected().exists(this.recordKey(key));
  }

  health(): Promise<CapabilityHealth> {
    if (!this.client) {
      return Promise.resolve(
        capabilityDown('aerospike', 'Aerospike client unavailable'),
      );
    }
    return Promise.resolve(
      this.client.isConnected(false)
        ? capabilityUp('aerospike')
        : capabilityDown('aerospike', 'client reports disconnected'),
    );
  }

  private connected(): AerospikeKvClient {
    if (!this.client) throw new Error('Aerospike client unavailable');
    return this.client;
  }

  private recordKey(key: KvKey): unknown {
    return new this.Key(this.options.namespace, this.options.set, key);
  }
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === ERR_RECORD_NOT_FOUND;
}
