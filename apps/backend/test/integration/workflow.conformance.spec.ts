import { Client, Connection } from '@temporalio/client';
import { DisabledWorkflowAdapter } from '../../src/infrastructure/workflow/adapters/disabled/disabled-workflow.adapter';
import { TemporalClientHolder } from '../../src/infrastructure/workflow/adapters/temporal/temporal-client.holder';
import { TemporalWorkflowAdapter } from '../../src/infrastructure/workflow/adapters/temporal/temporal-workflow.adapter';
import {
  conformanceRegistry,
  describeWorkflowPort,
} from '../../src/infrastructure/workflow/__tests__/workflow.conformance';
import { describeWithDocker } from './docker';
import {
  freePort,
  readyOrStop,
  startContainer,
  waitUntil,
  type StartedContainer,
} from './containers';

jest.setTimeout(240_000);

const NAMESPACE = 'default';

async function connect(address: string): Promise<Client> {
  const connection = await Connection.connect({
    address,
    connectTimeout: '3s',
  });
  return new Client({ connection, namespace: NAMESPACE });
}

describeWithDocker('Workflow conformance (temporal)')(
  'Workflow conformance (temporal)',
  () => {
    let container: StartedContainer;
    let address: string;

    beforeAll(async () => {
      container = startContainer({
        image: 'temporalio/temporal:1.4.1',
        label: 'temporal',
        ports: [7233],
        command: ['server', 'start-dev', '--ip', '0.0.0.0', '--headless'],
      });
      address = `${container.host}:${container.port(7233)}`;
      await readyOrStop(container, () =>
        waitUntil(
          'temporal',
          async () => {
            const client = await connect(address);
            try {
              await client.workflow.count('');
              return true;
            } finally {
              await client.connection.close();
            }
          },
          120_000,
          container,
        ),
      );
    });

    afterAll(async () => {
      await container?.stop();
    });

    describeWorkflowPort('temporal', {
      live: {
        visibilityLagMs: 15_000,
        make: async () => {
          const holder = new TemporalClientHolder(() => connect(address));
          await holder.get();
          return new TemporalWorkflowAdapter(holder, conformanceRegistry());
        },
        teardown: (port) =>
          (port as TemporalWorkflowAdapter).onApplicationShutdown(),
      },
      unavailable: [
        {
          label: 'the adapter is disabled',
          status: 'disabled',
          make: () => new DisabledWorkflowAdapter(),
        },
        {
          label: 'Temporal is unreachable',
          status: 'down',
          make: async () => {
            const unreachable = `127.0.0.1:${await freePort()}`;
            const holder = new TemporalClientHolder(() => connect(unreachable));
            await holder.get();
            return new TemporalWorkflowAdapter(holder, conformanceRegistry());
          },
        },
      ],
    });
  },
);
