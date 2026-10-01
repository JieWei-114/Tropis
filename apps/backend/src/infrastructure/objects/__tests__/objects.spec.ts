import { CapabilityDisabledError } from '../../capability';
import { DisabledObjectsAdapter } from '../adapters/disabled/disabled-objects.adapter';
import { MinioObjectsAdapter } from '../adapters/minio/minio-objects.adapter';
import { toTenantId } from '../../../common/keyspace';

const T = toTenantId('acme');

describe('MinioObjectsAdapter', () => {
  const client = {
    bucketExists: jest.fn(),
    makeBucket: jest.fn().mockResolvedValue(undefined),
    putObject: jest.fn().mockResolvedValue({ etag: 'abc' }),
    presignedGetObject: jest.fn().mockResolvedValue('http://signed'),
    removeObject: jest.fn().mockResolvedValue(undefined),
  };
  const adapter = new MinioObjectsAdapter(
    {
      endPoint: 'localhost',
      port: 9000,
      useSSL: false,
      accessKey: 'a',
      secretKey: 's',
      bucket: 'app-uploads',
    },
    client as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('creates the bucket on init if it does not exist', async () => {
    client.bucketExists.mockResolvedValue(false);
    await adapter.onModuleInit();
    expect(client.makeBucket).toHaveBeenCalledWith('app-uploads', 'us-east-1');
  });

  it('skips bucket creation if the bucket already exists', async () => {
    client.bucketExists.mockResolvedValue(true);
    await adapter.onModuleInit();
    expect(client.makeBucket).not.toHaveBeenCalled();
  });

  it('warns (does not throw) when the server is unreachable on init', async () => {
    client.bucketExists.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(adapter.onModuleInit()).resolves.toBeUndefined();
  });

  // Reproduces the gap: keys were bucket-global, so nothing but a path
  // convention kept one tenant's avatars from another's.
  it("puts an object under the tenant's prefix with its content type", async () => {
    await expect(
      adapter.put(T, 'avatars/u/1.png', Buffer.from('data'), 4, 'image/png'),
    ).resolves.toEqual({ bucket: 'app-uploads', key: 'avatars/u/1.png' });
    expect(client.putObject).toHaveBeenCalledWith(
      'app-uploads',
      't.acme/avatars/u/1.png',
      expect.any(Buffer),
      4,
      { 'Content-Type': 'image/png' },
    );
  });

  it('presigns a GET for the tenant key in the configured bucket', async () => {
    await expect(adapter.presignedGet(T, 'k', 60)).resolves.toBe(
      'http://signed',
    );
    expect(client.presignedGetObject).toHaveBeenCalledWith(
      'app-uploads',
      't.acme/k',
      60,
    );
  });

  it('asks the store to answer the presigned GET with the given disposition', async () => {
    await adapter.presignedGet(T, 'k', 60, {
      contentDisposition: 'attachment; filename="a.png"',
    });
    expect(client.presignedGetObject).toHaveBeenLastCalledWith(
      'app-uploads',
      't.acme/k',
      60,
      { 'response-content-disposition': 'attachment; filename="a.png"' },
    );
  });

  it.each(['../x', '/abs', 'a//b', ''])('rejects the key %p', async (key) => {
    await expect(adapter.presignedGet(T, key, 60)).rejects.toThrow(
      /Invalid object key/,
    );
  });

  it('reports down when the server does not answer', async () => {
    client.bucketExists.mockRejectedValue(new Error('down'));
    await expect(adapter.health()).resolves.toMatchObject({
      status: 'down',
      adapter: 'minio',
    });
  });
});

describe('DisabledObjectsAdapter', () => {
  it('rejects calls and reports disabled', async () => {
    const adapter = new DisabledObjectsAdapter();
    await expect(adapter.put()).rejects.toBeInstanceOf(CapabilityDisabledError);
    await expect(adapter.health()).resolves.toMatchObject({
      status: 'disabled',
    });
  });
});
