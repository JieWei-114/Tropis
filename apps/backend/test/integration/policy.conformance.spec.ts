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

const POLICY = resolve(__dirname, '../../../../infra/opa/authz.rego');

describeWithDocker('Policy conformance (opa)')(
  'Policy conformance (opa)',
  () => {
    let container: StartedContainer;
    let url: string;

    beforeAll(async () => {
      container = startContainer({
        image: 'openpolicyagent/opa:1.20.1',
        label: 'opa',
        ports: [8181],
        command: ['run', '--server', '--addr', '0.0.0.0:8181'],
      });
      url = `http://${container.host}:${container.port(8181)}`;
      await readyOrStop(container, async () => {
        await waitUntil(
          'opa',
          async () => (await fetch(`${url}/health`)).ok,
          60_000,
          container,
        );
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
