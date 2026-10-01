import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { ClickHouseOlapEngine } from '../../src/infrastructure/olap/adapters/clickhouse/clickhouse-olap.engine';
import { OlapClient } from '../../src/infrastructure/olap/olap.client';
import { describeOlapPort } from '../../src/infrastructure/olap/__tests__/olap.conformance';
import { describeWithDocker } from './docker';
import {
  readyOrStop,
  startContainer,
  waitUntil,
  type StartedContainer,
} from './containers';

jest.setTimeout(240_000);

const TABLE = 'conformance_rows';
const MISORDERED_TABLE = 'conformance_rows_misordered';

describeWithDocker('OLAP conformance (clickhouse)')(
  'OLAP conformance (clickhouse)',
  () => {
    let container: StartedContainer;
    let ch: ClickHouseClient;
    let olap: OlapClient;

    beforeAll(async () => {
      container = startContainer({
        image: 'clickhouse/clickhouse-server:24',
        label: 'clickhouse',
        ports: [8123],
        env: { CLICKHOUSE_PASSWORD: 'conformance' },
      });
      ch = createClient({
        url: `http://${container.host}:${container.port(8123)}`,
        username: 'default',
        password: 'conformance',
      });
      await readyOrStop(container, () =>
        waitUntil(
          'clickhouse',
          async () => {
            await ch.command({ query: 'SELECT 1' });
            return true;
          },
          120_000,
          container,
        ),
      );
      await ch.command({
        query: `CREATE TABLE ${TABLE} (tenant_id String, id String, n Int64)
                ENGINE = MergeTree ORDER BY (tenant_id, id)`,
      });
      await ch.command({
        query: `CREATE TABLE ${MISORDERED_TABLE} (tenant_id String, id String, n Int64)
                ENGINE = MergeTree ORDER BY (id, tenant_id)`,
      });
      olap = new OlapClient(new ClickHouseOlapEngine({} as never, ch));
    });

    afterAll(async () => {
      await ch?.close();
      await container?.stop();
    });

    describeOlapPort('clickhouse', {
      make: () => olap,
      table: TABLE,
      misorderedTable: MISORDERED_TABLE,
    });
  },
);
