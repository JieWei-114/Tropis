import { Neo4jGraphEngine } from '../../src/infrastructure/graph/adapters/neo4j/neo4j-graph.engine';
import { GraphClient } from '../../src/infrastructure/graph/graph.client';
import { describeGraphPort } from '../../src/infrastructure/graph/__tests__/graph.conformance';
import { describeWithDocker } from './docker';
import {
  readyOrStop,
  startContainer,
  waitUntil,
  type StartedContainer,
} from './containers';

jest.setTimeout(240_000);

const PASSWORD = 'tropis_dev_password';

describeWithDocker('Graph conformance (neo4j)')(
  'Graph conformance (neo4j)',
  () => {
    let container: StartedContainer;
    let graph: GraphClient;

    beforeAll(async () => {
      container = startContainer({
        image: 'neo4j:5-community',
        label: 'neo4j',
        ports: [7687],
        env: { NEO4J_AUTH: `neo4j/${PASSWORD}` },
      });
      graph = new GraphClient(
        new Neo4jGraphEngine({
          uri: `bolt://${container.host}:${container.port(7687)}`,
          user: 'neo4j',
          password: PASSWORD,
        }),
      );
      await readyOrStop(container, () =>
        waitUntil(
          'neo4j',
          async () => (await graph.health()).status === 'up',
          180_000,
          container,
        ),
      );
    });

    afterAll(async () => {
      await graph?.onApplicationShutdown();
      await container?.stop();
    });

    describeGraphPort('neo4j', { make: () => graph });
  },
);
