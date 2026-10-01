import { toTenantId } from '../../../common/keyspace';
import { LocalRealtimeAdapter } from '../adapters/local/local-realtime.adapter';
import { RedisRealtimeAdapter } from '../adapters/redis/redis-realtime.adapter';
import { realtimeChannelKey, tenantRoom, userRoom } from '../realtime.rooms';
import { describeRealtimePort } from './realtime.conformance';
import { startGatewayNode } from './realtime-harness';

const ACME = toTenantId('acme');
const GLOBEX = toTenantId('globex');

describe('realtime rooms', () => {
  it('scopes every room to one tenant', () => {
    expect(tenantRoom(ACME)).toBe('t.acme');
    expect(userRoom(ACME, 'u1')).toBe('t.acme:user:u1');
    expect(userRoom(ACME, 'u1')).not.toBe(userRoom(GLOBEX, 'u1'));
  });

  it('escapes ids so a user id cannot forge another room', () => {
    expect(userRoom(ACME, 'x:user:y')).toBe('t.acme:user:x%3Auser%3Ay');
  });

  it('rejects an unbranded or invalid tenant', () => {
    expect(() => tenantRoom('a:b' as never)).toThrow();
  });

  it('prefixes the channel with the keyspace app and env', () => {
    expect(realtimeChannelKey({ app: 'tropis', env: 'prod' })).toBe(
      'tropis:prod:global:realtime:socket-io:v1',
    );
  });
});

describe('LocalRealtimeAdapter', () => {
  it('drops publishes when this process holds no sockets', async () => {
    const adapter = new LocalRealtimeAdapter();
    await expect(
      adapter.publishToTenant(ACME, 'x', {}),
    ).resolves.toBeUndefined();
    expect((await adapter.health()).status).toBe('up');
  });
});

describe('RedisRealtimeAdapter', () => {
  it('publishes to the tenant-scoped room channel under the keyspace key', async () => {
    const redis = {
      publish: jest.fn().mockResolvedValue(1),
      ping: jest.fn().mockResolvedValue('PONG'),
    };
    const key = realtimeChannelKey({ app: 'tropis', env: 'test' });
    const adapter = new RedisRealtimeAdapter(redis as never, key);

    await adapter.publishToUser(ACME, 'u1', 'notification', { a: 1 });
    await adapter.publishToTenant(GLOBEX, 'news', {});

    const channels = (redis.publish.mock.calls as [string][]).map(
      ([channel]) => channel,
    );
    expect(channels).toEqual([
      `${key}#/ws#${userRoom(ACME, 'u1')}#`,
      `${key}#/ws#${tenantRoom(GLOBEX)}#`,
    ]);
    expect((await adapter.health()).status).toBe('up');
  });
});

describeRealtimePort('local', async () => {
  const adapter = new LocalRealtimeAdapter();
  const node = await startGatewayNode(adapter);
  return {
    publisher: adapter,
    nodes: [node],
    teardown: () => node.close(),
  };
});
