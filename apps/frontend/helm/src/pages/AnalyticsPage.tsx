import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Seo } from '../features/seo';
import {
  fetchStats,
  fetchRecent,
  fetchMinutelyStats,
  type AnalyticsEvent,
  type AnalyticsStats,
  type MinutelyStat,
} from '../lib/api';
import { connectWs } from '../lib/websocket';
import { useTrackingInsights } from '../state/tanstack/useTrackingQuery';
import {
  StatsCards,
  EventChart,
  MinutelyChart,
  LiveFeed,
  FireEventPanel,
} from '../features/analytics';
import {
  TopPagesTable,
  EventsByNameChart,
  DailyUniquesTable,
  FunnelChart,
} from '../features/behavior';

const MAX_FEED = 30;

export function AnalyticsPage() {
  const { t } = useTranslation();

  // Analytics events (ClickHouse) — top metrics, per-type + per-minute charts, live feed.
  const [stats, setStats] = useState<AnalyticsStats | null>(null);
  const [liveEvents, setLiveEvents] = useState<AnalyticsEvent[]>([]);
  const [minutelyData, setMinutelyData] = useState<MinutelyStat[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Tracking insights (7-day) — top pages, funnel, daily uniques.
  const insights = useTrackingInsights(7);

  const [live, setLive] = useState(false);
  const liveTimer = useRef<ReturnType<typeof setTimeout>>();
  const lastInsightRefetch = useRef(0);
  const lastStatsRefetch = useRef(0);

  // `silent` skips the loading skeleton: WebSocket-driven refreshes would
  // otherwise flash the stat cards into skeletons on every incoming event.
  const refreshStats = useCallback(async (silent = false) => {
    if (!silent) setStatsLoading(true);
    try {
      const [s, m] = await Promise.all([fetchStats(), fetchMinutelyStats(60)]);
      setStats(s);
      setMinutelyData(m);
      setLoadError('');
    } catch (err) {
      // Without this the `void refreshStats()` call sites produce unhandled
      // rejections and the page just shows empty charts forever.
      setLoadError((err as Error).message);
    } finally {
      if (!silent) setStatsLoading(false);
    }
  }, []);

  // `insights` is a fresh object each render; keep only a stable ref to its
  // refetch so the WebSocket effect below doesn't tear down and re-handshake
  // the socket on every render.
  const refetchInsights = insights.refetch;
  const refetchInsightsRef = useRef(refetchInsights);
  refetchInsightsRef.current = refetchInsights;

  const refreshAll = useCallback(() => {
    void refreshStats();
    void refetchInsightsRef.current();
  }, [refreshStats]);

  useEffect(() => {
    void fetchRecent()
      .then((events) => setLiveEvents(events.slice(0, MAX_FEED)))
      .catch((err: Error) => setLoadError(err.message));
    void refreshStats();
  }, [refreshStats]);

  useEffect(() => {
    // One WebSocket stream feeds both stories: 'analytics.event' pushes the live
    // feed + stats, 'tracking.event' throttle-refreshes the behavior insights.
    const unsubscribe = connectWs((e) => {
      if (e.name === 'analytics.event') {
        // The gateway broadcasts an outbox ENVELOPE, not the event itself:
        // { eventId: <outbox row id>, eventType, aggregateId, payload: {…},
        //   timestamp: <relay time> }. The domain event is `payload`; the
        // envelope's own `eventId` and `timestamp` describe the outbox row and
        // the relay, so dedupe against fetchRecent() only works on the
        // payload's ids.
        const envelope = e.data as { payload?: unknown };
        const event = (envelope.payload ?? e.data) as unknown as AnalyticsEvent;
        setLiveEvents((prev) => {
          if (prev.some((ev) => ev.eventId === event.eventId)) return prev;
          return [event, ...prev].slice(0, MAX_FEED);
        });
        // Throttled like the tracking branch — a burst of events would
        // otherwise fire two RPCs per message.
        const now = Date.now();
        if (now - lastStatsRefetch.current > 2000) {
          lastStatsRefetch.current = now;
          void refreshStats(true);
        }
      } else if (e.name === 'tracking.event') {
        setLive(true);
        clearTimeout(liveTimer.current);
        liveTimer.current = setTimeout(() => setLive(false), 8000);
        const now = Date.now();
        if (now - lastInsightRefetch.current > 3000) {
          lastInsightRefetch.current = now;
          void refetchInsightsRef.current();
        }
      }
    });
    return () => {
      clearTimeout(liveTimer.current);
      unsubscribe();
    };
  }, [refreshStats]);

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-8 pt-8 pb-12 max-md:px-4">
      <Seo title={t('analytics.title')} noindex />

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-[-0.4px] text-heading">
              {t('analytics.title')}
            </h1>
            {live && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-0.5 text-[11px] font-medium text-success">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                live
              </span>
            )}
          </div>
          <p className="text-[13px] text-muted">{t('analytics.subtitle')}</p>
        </div>
        <button
          className="cursor-pointer rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-medium text-soft transition-colors hover:bg-surface"
          onClick={refreshAll}
        >
          {t('common.refresh')}
        </button>
      </header>

      {loadError && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {loadError}
        </p>
      )}

      <StatsCards stats={stats} loading={statsLoading} />

      {/* Main column + activity rail — not a single stacked ribbon. */}
      <div className="grid grid-cols-[minmax(0,1fr)_336px] gap-6 max-[1100px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-6">
          <EventChart data={stats?.byType ?? []} />
          <MinutelyChart data={minutelyData} />
          <FunnelChart data={insights.data} isLoading={insights.isLoading} />
          <div className="grid grid-cols-2 gap-6 max-[720px]:grid-cols-1">
            <TopPagesTable
              data={insights.data}
              isLoading={insights.isLoading}
            />
            <EventsByNameChart
              data={insights.data}
              isLoading={insights.isLoading}
            />
          </div>
          <DailyUniquesTable
            data={insights.data}
            isLoading={insights.isLoading}
          />
        </div>

        <aside className="flex min-w-0 flex-col gap-6 self-start max-[1100px]:flex-row max-[720px]:flex-col">
          <div className="min-w-0 flex-1">
            <FireEventPanel onEventFired={() => void refreshStats()} />
          </div>
          <div className="min-w-0 flex-1 max-[1100px]:min-w-0">
            <LiveFeed events={liveEvents} />
          </div>
        </aside>
      </div>
    </div>
  );
}
