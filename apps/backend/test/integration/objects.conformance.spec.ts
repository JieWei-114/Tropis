import { MinioObjectsAdapter } from '../../src/infrastructure/objects/adapters/minio/minio-objects.adapter';
import { describeObjectsPort } from '../../src/infrastructure/objects/__tests__/objects.conformance';
import { describeWithDocker } from './docker';
import {
  readyOrStop,
  startContainer,
  waitUntil,
  type StartedContainer,
} from './containers';

jest.setTimeout(240_000);

describeWithDocker('Objects conformance (minio)')(
  'Objects conformance (minio)',
  () => {
    let container: StartedContainer;
    let objects: MinioObjectsAdapter;

    beforeAll(async () => {
      container = startContainer({
        image: 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z',
        label: 'minio',
        ports: [9000],
        env: {
          MINIO_ROOT_USER: 'conformance',
          MINIO_ROOT_PASSWORD: 'conformance-secret',
        },
        command: ['server', '/data'],
      });
      objects = new MinioObjectsAdapter({
        endPoint: container.host,
        port: container.port(9000),
        useSSL: false,
        accessKey: 'conformance',
        secretKey: 'conformance-secret',
        bucket: 'conformance',
      });
      await readyOrStop(container, () =>
        waitUntil(
          'minio',
          async () => (await objects.health()).status === 'up',
          120_000,
          container,
        ),
      );
    });

    afterAll(async () => {
      await container?.stop();
    });

    describeObjectsPort('minio', { make: () => objects });
  },
);
