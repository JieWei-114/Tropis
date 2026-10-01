import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';

const RedisMock = jest.fn().mockImplementation(() => ({
  quit: jest.fn().mockResolvedValue('OK'),
}));
jest.mock('ioredis', () => ({ __esModule: true, default: RedisMock }));

import {
  REDIS_CLIENT,
  RedisConnectionModule,
} from '../redis/redis-connection.module';

describe('RedisConnectionModule', () => {
  it('bounds every command and the connect, so a hung Redis fails callers', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ REDIS_HOST: 'localhost', REDIS_PORT: 6379 })],
        }),
        RedisConnectionModule,
      ],
    }).compile();
    expect(moduleRef.get(REDIS_CLIENT)).toBeDefined();
    expect(RedisMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commandTimeout: expect.any(Number),
        connectTimeout: expect.any(Number),
      }),
    );
    await moduleRef.close();
  });
});
