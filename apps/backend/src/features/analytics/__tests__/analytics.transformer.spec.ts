import { timestampDate } from '@bufbuild/protobuf/wkt';
import { AnalyticsTransformer } from '../transformers/analytics.transformer';

const MS = 1700000000123;
const iso = (t: unknown) =>
  timestampDate(t as Parameters<typeof timestampDate>[0]).toISOString();

describe('AnalyticsTransformer timestamps', () => {
  it('sends the event time as a Timestamp next to the epoch-ms field', () => {
    const e = AnalyticsTransformer.toRpcEvent({
      eventId: 'e',
      eventType: 'page_view',
      userId: 'u',
      metadata: {},
      timestamp: MS,
    });
    expect(e.timestamp).toBe(BigInt(MS));
    expect(iso(e.eventTime)).toBe('2023-11-14T22:13:20.123Z');
  });

  it('sends cache, last-seen and window times as Timestamps', () => {
    const stats = AnalyticsTransformer.toRpcStats({
      totalEvents: 1,
      byType: [{ eventType: 'page_view', count: 1, lastSeen: MS }],
      cachedAt: MS,
      fromCache: false,
    });
    expect(iso(stats.cacheTime)).toBe(new Date(MS).toISOString());
    expect(iso(stats.byType?.[0]?.lastSeenTime)).toBe(
      new Date(MS).toISOString(),
    );
    const minutely = AnalyticsTransformer.toRpcMinutely([
      { windowMs: MS, eventType: 'page_view', count: 2 },
    ]);
    expect(iso(minutely.stats?.[0]?.windowStartTime)).toBe(
      new Date(MS).toISOString(),
    );
  });
});
