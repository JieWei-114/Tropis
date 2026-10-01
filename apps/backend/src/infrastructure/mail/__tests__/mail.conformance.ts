import type { ConformanceTarget } from '../../capability/__tests__/conformance-helpers';
import type { MailMessage, MailPort } from '../mail.port';

export interface MailConformanceTarget extends ConformanceTarget<MailPort> {
  /** The messages the backing server received, oldest first. */
  received(): Promise<MailMessage[]>;
}

/** Behaviour every delivering MailPort adapter must share. */
export function describeMailPort(
  name: string,
  target: MailConformanceTarget,
): void {
  describe(`MailPort conformance: ${name}`, () => {
    let port: MailPort;

    beforeAll(async () => {
      port = await target.make();
    });

    afterAll(async () => {
      await target.teardown?.(port);
    });

    it('delivers to, subject and body', async () => {
      const subject = `conformance ${Date.now()}`;
      await port.send({
        to: 'someone@example.test',
        subject,
        text: 'plain body',
        html: '<p>html body</p>',
      });

      const received = await target.received();
      const message = received.find((m) => m.subject === subject);
      expect(message).toBeDefined();
      expect(message!.to).toContain('someone@example.test');
    });

    it('reports up', async () => {
      await expect(port.health()).resolves.toMatchObject({ status: 'up' });
    });
  });
}
