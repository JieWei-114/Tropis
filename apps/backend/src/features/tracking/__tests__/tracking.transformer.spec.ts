import { timestampDate } from '@bufbuild/protobuf/wkt';
import { TrackingTransformer } from '../transformers/tracking.transformer';

describe('TrackingTransformer timestamps', () => {
  it('sends the event time as a Timestamp next to the epoch-ms field', () => {
    const res = TrackingTransformer.toInsightsResponse({
      topPages: [],
      eventsByName: [],
      dailyUniques: [],
      funnel: [],
      recent: [
        {
          eventId: 'e',
          eventName: 'page.view',
          anonymousId: 'a',
          userId: '',
          sessionId: 's',
          page: '/',
          props: '{}',
          timestamp: 1700000000500,
        },
      ],
    });
    const recent = res.recent?.[0];
    expect(recent?.timestamp).toBe(1700000000500n);
    expect(
      timestampDate(
        recent?.eventTime as Parameters<typeof timestampDate>[0],
      ).toISOString(),
    ).toBe('2023-11-14T22:13:20.500Z');
  });
});
