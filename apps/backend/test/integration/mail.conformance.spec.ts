import { SmtpMailAdapter } from '../../src/infrastructure/mail/adapters/smtp/smtp-mail.adapter';
import { describeMailPort } from '../../src/infrastructure/mail/__tests__/mail.conformance';
import type { MailMessage } from '../../src/infrastructure/mail/mail.port';
import { describeWithDocker } from './docker';
import {
  readyOrStop,
  startContainer,
  waitUntil,
  type StartedContainer,
} from './containers';

jest.setTimeout(240_000);

interface MailpitMessage {
  To: { Address: string }[];
  Subject: string;
}

describeWithDocker('Mail conformance (smtp)')('Mail conformance (smtp)', () => {
  let container: StartedContainer;
  let mail: SmtpMailAdapter;
  let api: string;

  beforeAll(async () => {
    container = startContainer({
      image: 'axllent/mailpit:v1.31.3',
      label: 'mailpit',
      ports: [1025, 8025],
    });
    api = `http://${container.host}:${container.port(8025)}`;
    const options = {
      host: container.host,
      port: container.port(1025),
      from: 'conformance@example.test',
    };
    mail = new SmtpMailAdapter(options);
    await readyOrStop(container, () =>
      waitUntil(
        'mailpit',
        async () =>
          (await new SmtpMailAdapter(options).health()).status === 'up' &&
          (await fetch(`${api}/api/v1/messages`)).ok,
        60_000,
        container,
      ),
    );
  });

  afterAll(async () => {
    await container?.stop();
  });

  describeMailPort('smtp', {
    make: () => mail,
    received: async (): Promise<MailMessage[]> => {
      const res = await fetch(`${api}/api/v1/messages`);
      const body = (await res.json()) as { messages: MailpitMessage[] };
      return body.messages.map((m) => ({
        to: m.To?.[0]?.Address ?? '',
        subject: m.Subject ?? '',
      }));
    },
  });
});
