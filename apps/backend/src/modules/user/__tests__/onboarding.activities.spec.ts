import type { RealtimePort } from '../../../infrastructure/realtime/realtime.port';
import type { NotificationService } from '../../notification/services/notification.service';
import { OnboardingActivities } from '../workflows/onboarding.activities';

function activities(sendEmail: jest.Mock) {
  const realtime = {
    publishToUser: jest.fn().mockResolvedValue(undefined),
  } as unknown as RealtimePort;
  return new OnboardingActivities(
    { sendEmail } as unknown as NotificationService,
    realtime,
  );
}

const input = {
  tenantId: 'acme',
  userId: 'u1',
  email: 'ada@example.com',
  name: '<img src=x onerror=alert(1)>',
};

describe('OnboardingActivities.sendFollowUpEmail', () => {
  it('HTML-escapes the name in the email body', async () => {
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    await activities(sendEmail).sendFollowUpEmail(input);
    const [{ html }] = sendEmail.mock.calls[0] as [{ html: string }];
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('rejects when the email is not sent, so the engine retries the activity', async () => {
    const sendEmail = jest.fn().mockRejectedValue(new Error('SMTP down'));
    await expect(
      activities(sendEmail).sendFollowUpEmail(input),
    ).rejects.toThrow('SMTP down');
  });
});
