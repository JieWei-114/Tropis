import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';

const close = jest.fn().mockResolvedValue(undefined);
jest.mock('pulsar-client', () => ({
  __esModule: true,
  default: { Client: jest.fn().mockImplementation(() => ({ close })) },
}));

import {
  PulsarConnectionModule,
  PULSAR_CLIENT,
} from '../pulsar/pulsar-connection.module';

describe('PulsarConnectionModule', () => {
  beforeEach(() => close.mockClear());

  // The client is native: left open, its threads keep the process alive after
  // app.close(), so a SIGTERM'd pod never exits on its own.
  it('closes the Pulsar client when the application shuts down', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ PULSAR_SERVICE_URL: 'pulsar://localhost:6650' })],
        }),
        PulsarConnectionModule,
      ],
    }).compile();
    expect(moduleRef.get(PULSAR_CLIENT)).toBeDefined();

    await moduleRef.close();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
