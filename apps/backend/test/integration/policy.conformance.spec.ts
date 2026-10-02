import { readFileSync } from 'fs';
import { resolve } from 'path';
import { OpaPolicyAdapter } from '../../src/infrastructure/policy/adapters/opa/opa-policy.adapter';
import { describePolicyPort } from '../../src/infrastructure/policy/__tests__/policy.conformance';
import { describeWithDocker } from './docker';
import {
  freePort,
  readyOrStop,
  startContainer,
  waitUntil,
  type StartedContainer,
} from './containers';

jest.setTimeout(240_000);

const POLICIES = resolve(__dirname, '../../../../infra/opa');
const POLICY = resolve(POLICIES, 'authz.rego');
// The OPA version the shipped image uses: the FROM line of infra/opa/Dockerfile.
const IMAGE = readFileSync(resolve(POLICIES, 'Dockerfile'), 'utf8').match(
  /^FROM\s+(\S+)/m,
)![1];
const TOKEN = 'conformance-opa-token';

async function waitForHealth(
  container: StartedContainer,
  url: string,
): Promise<void> {
  await waitUntil(
    'opa',
    async () => (await fetch(`${url}/health`)).ok,
    60_000,
    container,
  );
}

describeWithDocker('Policy conformance (opa)')(
  'Policy conformance (opa)',
  () => {
    let container: StartedContainer;
    let url: string;

    beforeAll(async () => {
      container = startContainer({
        image: IMAGE,
        label: 'opa',
        ports: [8181],
        command: ['run', '--server', '--addr', '0.0.0.0:8181'],
      });
      url = `http://${container.host}:${container.port(8181)}`;
      await readyOrStop(container, async () => {
        await waitForHealth(container, url);
        const res = await fetch(`${url}/v1/policies/authz`, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: readFileSync(POLICY, 'utf8'),
        });
        if (!res.ok)
          throw new Error(`Loading the policy failed: ${res.status}`);
      });
    });

    afterAll(async () => {
      await container?.stop();
    });

    describePolicyPort('opa', {
      live: { make: () => new OpaPolicyAdapter(url) },
      unreachable: {
        make: async () =>
          new OpaPolicyAdapter(`http://127.0.0.1:${await freePort()}`),
      },
    });
  },
);

describeWithDocker('Policy conformance (opa, token auth)')(
  'Policy conformance (opa, token auth)',
  () => {
    let container: StartedContainer;
    let url: string;

    beforeAll(async () => {
      container = startContainer({
        image: IMAGE,
        label: 'opa-token',
        ports: [8181],
        env: { OPA_TOKEN: TOKEN },
        volumes: { [POLICIES]: '/policies' },
        command: [
          'run',
          '--server',
          '--addr',
          '0.0.0.0:8181',
          '--authentication=token',
          '--authorization=basic',
          '/policies',
        ],
      });
      url = `http://${container.host}:${container.port(8181)}`;
      await readyOrStop(container, () => waitForHealth(container, url));
    });

    afterAll(async () => {
      await container?.stop();
    });

    it('rejects an API call without the token', async () => {
      const res = await fetch(`${url}/v1/policies`);
      expect(res.status).toBe(401);
    });

    describePolicyPort('opa with token auth', {
      live: { make: () => new OpaPolicyAdapter(url, TOKEN) },
      unreachable: {
        make: async () =>
          new OpaPolicyAdapter(`http://127.0.0.1:${await freePort()}`, TOKEN),
      },
      credentials: {
        wrong: { make: () => new OpaPolicyAdapter(url, 'not-the-token') },
        missing: { make: () => new OpaPolicyAdapter(url) },
      },
    });
  },
);
