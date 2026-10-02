import {
  Injectable,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OpsServer } from '../../../modules/health/ops-server';
import { HealthProbesService } from '../../../modules/health/services/health-probes.service';
import { opsPortFromEnv, shutdownDeadlineMs, shutdownRole } from '../bootstrap';

const order: string[] = [];
let readyzDuringTeardown: number | undefined;
let opsBase = '';

@Injectable()
class Consumer implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    readyzDuringTeardown = (await fetch(`${opsBase}/readyz`)).status;
    order.push('consumer');
  }
}

@Injectable()
class Connection implements OnApplicationShutdown {
  onApplicationShutdown(): void {
    order.push('connection');
  }
}

describe('shutdownRole', () => {
  beforeEach(() => {
    order.length = 0;
    readyzDuringTeardown = undefined;
  });

  async function boot() {
    const moduleRef = await Test.createTestingModule({
      providers: [
        OpsServer,
        Consumer,
        Connection,
        {
          provide: HealthProbesService,
          useValue: {
            report: () => Promise.resolve({ status: 'ok', degraded: [] }),
          },
        },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const port = await app.get(OpsServer).listen(0, '127.0.0.1');
    opsBase = `http://127.0.0.1:${port}`;
    return app;
  }

  it('stops accepting before consumers and connections are torn down', async () => {
    const app = await boot();
    expect((await fetch(`${opsBase}/readyz`)).status).toBe(200);

    let readyzWhileDraining: number | undefined;
    await shutdownRole(app, [
      async () => {
        readyzWhileDraining = (await fetch(`${opsBase}/readyz`)).status;
        order.push('listeners');
      },
    ]);

    expect(readyzWhileDraining).toBe(503);
    expect(readyzDuringTeardown).toBe(503);
    expect(order).toEqual(['listeners', 'consumer', 'connection']);
  });

  it('bounds the drain so a stuck listener cannot block teardown', async () => {
    const app = await boot();
    await shutdownRole(app, [() => new Promise<void>(() => undefined)], 20);
    expect(order).toEqual(['consumer', 'connection']);
  });

  it('closes an ops listener opened before boot only after teardown', async () => {
    const app = await boot();
    const early = new OpsServer();
    const port = await early.listen(0, '127.0.0.1');
    early.attach(app.get(HealthProbesService));
    const url = `http://127.0.0.1:${port}`;
    let earlyDuringTeardown: number | undefined;
    const original = Reflect.get(Consumer.prototype, 'onModuleDestroy') as (
      this: Consumer,
    ) => Promise<void>;
    Consumer.prototype.onModuleDestroy = async function (this: Consumer) {
      earlyDuringTeardown = (await fetch(`${url}/readyz`)).status;
      return original.call(this) as Promise<void>;
    };
    try {
      await shutdownRole(app, [], { ops: early });
    } finally {
      Consumer.prototype.onModuleDestroy = original;
    }
    expect(earlyDuringTeardown).toBe(503);
    await expect(fetch(`${url}/livez`)).rejects.toThrow();
  });
});

describe('shutdown limits', () => {
  it('gives the worker longer than the request-serving roles', () => {
    expect(shutdownDeadlineMs('worker', {})).toBeGreaterThan(
      shutdownDeadlineMs('public', {}),
    );
    expect(shutdownDeadlineMs('public', { SHUTDOWN_TIMEOUT_MS: '7000' })).toBe(
      7000,
    );
  });

  it('reads the ops port before config is validated', () => {
    expect(opsPortFromEnv({})).toBe(9464);
    expect(opsPortFromEnv({ OPS_PORT: '9500' })).toBe(9500);
  });
});
