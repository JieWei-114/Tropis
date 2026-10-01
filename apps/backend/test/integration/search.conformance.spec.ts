import { Client } from '@elastic/elasticsearch';
import { ElasticsearchSearchEngine } from '../../src/infrastructure/search/adapters/elasticsearch/elasticsearch-search.engine';
import { SearchClient } from '../../src/infrastructure/search/search.client';
import { toTenantId } from '../../src/common/keyspace';
import { describeSearchPort } from '../../src/infrastructure/search/__tests__/search.conformance';
import { describeWithDocker } from './docker';
import {
  readyOrStop,
  startContainer,
  waitUntil,
  type StartedContainer,
} from './containers';

jest.setTimeout(240_000);

describeWithDocker('Search conformance (elasticsearch)')(
  'Search conformance (elasticsearch)',
  () => {
    let container: StartedContainer;
    let es: Client;
    let search: SearchClient;

    beforeAll(async () => {
      container = startContainer({
        image: 'docker.elastic.co/elasticsearch/elasticsearch:8.13.4',
        label: 'elasticsearch',
        ports: [9200],
        env: {
          'discovery.type': 'single-node',
          'xpack.security.enabled': 'false',
          ES_JAVA_OPTS: '-Xms512m -Xmx512m',
        },
      });
      es = new Client({
        node: `http://${container.host}:${container.port(9200)}`,
      });
      await readyOrStop(container, () =>
        waitUntil(
          'elasticsearch',
          async () => {
            const health = await es.cluster.health({
              wait_for_status: 'yellow',
              timeout: '5s',
            });
            return health.status !== 'red';
          },
          180_000,
          container,
        ),
      );
      search = new SearchClient(
        new ElasticsearchSearchEngine({ node: 'unused' }, es),
      );
    });

    afterAll(async () => {
      await es?.close();
      await container?.stop();
    });

    describeSearchPort('elasticsearch', {
      make: () => search,
      refresh: async (index) => {
        await es.indices.refresh({ index });
      },
    });

    describe('tenant fence', () => {
      const acme = toTenantId('acme');
      const acmeCorp = toTenantId('acme-corp');

      it('maps tenantId as a keyword on a write to an index never ensured', async () => {
        const index = `fence-${Date.now()}`;
        const fresh = new SearchClient(
          new ElasticsearchSearchEngine({ node: 'unused' }, es),
        );
        await fresh.index(acmeCorp, index, 'u1', { id: 'u1', name: 'alpha' });
        await es.indices.refresh({ index });

        const leaked = await fresh.query(acme, index, 'alpha', {
          fields: ['name'],
        });
        expect(leaked.total).toBe(0);
        const own = await fresh.query(acmeCorp, index, 'alpha', {
          fields: ['name'],
        });
        expect(own.total).toBe(1);
      });

      it('refuses writes to an index whose tenantId is not a keyword', async () => {
        const index = `fence-text-${Date.now()}`;
        await es.indices.create({
          index,
          mappings: { properties: { tenantId: { type: 'text' } } },
        });
        const fresh = new SearchClient(
          new ElasticsearchSearchEngine({ node: 'unused' }, es),
        );
        await expect(
          fresh.index(acme, index, 'u1', { id: 'u1', name: 'alpha' }),
        ).rejects.toThrow(/tenantId/);
        expect((await es.count({ index })).count).toBe(0);
      });

      it('never maps a dynamically added tenant-like field as text', async () => {
        const index = `fence-dyn-${Date.now()}`;
        await search.ensureIndex(index, { name: { type: 'text' } });
        await search.index(acme, index, 'u1', { name: 'alpha', note: 'x' });
        const mapping = await es.indices.getMapping({ index });
        expect(mapping[index].mappings.properties?.tenantId).toMatchObject({
          type: 'keyword',
        });
      });
    });
  },
);
