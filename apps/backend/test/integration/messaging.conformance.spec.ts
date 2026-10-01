import Pulsar from 'pulsar-client';
import { KafkaMessagingAdapter } from '../../src/infrastructure/messaging/adapters/kafka/kafka-messaging.adapter';
import { PulsarMessagingAdapter } from '../../src/infrastructure/messaging/adapters/pulsar/pulsar-messaging.adapter';
import { describeMessagingPort } from '../../src/infrastructure/messaging/__tests__/messaging.conformance';
import { describeWithDocker } from './docker';
import {
  freePort,
  readyOrStop,
  startContainer,
  waitUntil,
  type StartedContainer,
} from './containers';

jest.setTimeout(300_000);

describeWithDocker('Messaging conformance (kafka)')(
  'Messaging conformance (kafka)',
  () => {
    const redelivery = {
      maxRedeliveries: 2,
      redeliveryDelayMs: 500,
      maxRedeliveryDelayMs: 2_000,
    };
    let container: StartedContainer;
    let brokers: string[];

    beforeAll(async () => {
      // Kafka advertises its own address to clients, so the host port must
      // be known before start.
      const port = await freePort();
      container = startContainer({
        image: 'apache/kafka:3.8.0',
        label: 'kafka',
        fixedPorts: { 9092: port },
        env: {
          KAFKA_NODE_ID: '1',
          KAFKA_PROCESS_ROLES: 'broker,controller',
          KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
          KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${port}`,
          KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
          KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
            'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
          KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
          KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
          KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
          KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
          KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
        },
      });
      brokers = [`127.0.0.1:${port}`];
      const probe = new KafkaMessagingAdapter({ brokers, clientId: 'probe' });
      await readyOrStop(container, () =>
        waitUntil(
          'kafka',
          async () => (await probe.health()).status === 'up',
          120_000,
          container,
        ),
      ).finally(() => probe.close());
    });

    afterAll(async () => {
      await container?.stop();
    });

    describeMessagingPort('kafka', {
      redelivery,
      deliveryTimeoutMs: 30_000,
      make: () =>
        new KafkaMessagingAdapter({
          brokers,
          clientId: 'conformance',
          redelivery,
        }),
    });
  },
);

describeWithDocker('Messaging conformance (pulsar)')(
  'Messaging conformance (pulsar)',
  () => {
    const redelivery = {
      maxRedeliveries: 2,
      redeliveryDelayMs: 1_000,
      maxRedeliveryDelayMs: 4_000,
    };
    let container: StartedContainer;
    let client: Pulsar.Client;

    beforeAll(async () => {
      container = startContainer({
        image: 'apachepulsar/pulsar:3.3.0',
        label: 'pulsar',
        ports: [6650, 8080],
        command: ['bin/pulsar', 'standalone', '-nss', '-nfw'],
      });
      const admin = `http://${container.host}:${container.port(8080)}`;
      await readyOrStop(container, () =>
        waitUntil(
          'pulsar',
          async () => {
            const res = await fetch(`${admin}/admin/v2/brokers/health`);
            return res.ok && (await res.text()).trim() === 'ok';
          },
          180_000,
          container,
        ),
      );
      client = new Pulsar.Client({
        serviceUrl: `pulsar://${container.host}:${container.port(6650)}`,
        log: () => undefined,
      });
    });

    afterAll(async () => {
      await client?.close().catch(() => undefined);
      await container?.stop();
    });

    describeMessagingPort('pulsar', {
      redelivery,
      deliveryTimeoutMs: 20_000,
      make: () => new PulsarMessagingAdapter(client, redelivery),
    });
  },
);
