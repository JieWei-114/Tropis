import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';

const close = jest.fn();
const connect = jest.fn().mockResolvedValue(undefined);
jest.mock(
  'aerospike',
  () => ({ client: jest.fn(() => ({ connect, close })), log: { INFO: 4 } }),
  { virtual: true },
);

import {
  AerospikeConnectionModule,
  AEROSPIKE_CLIENT,
} from '../aerospike/aerospike-connection.module';

describe('AerospikeConnectionModule', () => {
  beforeEach(() => close.mockClear());

  // The client is native: left open, it keeps the process alive after
  // app.close(), so a SIGTERM'd pod never exits on its own.
  it('closes the Aerospike client when the application shuts down', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ AEROSPIKE_HOSTS: 'localhost:3000' })],
        }),
        AerospikeConnectionModule,
      ],
    }).compile();
    expect(moduleRef.get(AEROSPIKE_CLIENT)).not.toBeNull();

    await moduleRef.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  // A client whose connect() failed still owns native threads; left open,
  // they keep the process alive after app.close().
  it('releases a client that failed to connect, and shuts down cleanly', async () => {
    connect.mockRejectedValueOnce(new Error('connection refused'));
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ AEROSPIKE_HOSTS: 'localhost:3000' })],
        }),
        AerospikeConnectionModule,
      ],
    }).compile();
    expect(moduleRef.get(AEROSPIKE_CLIENT)).toBeNull();

    expect(close).toHaveBeenCalledTimes(1);
    await expect(moduleRef.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
