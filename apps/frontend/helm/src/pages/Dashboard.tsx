import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Seo } from '../features/seo';
import {
  fetchStats,
  fetchRecent,
  fetchMinutelyStats,
  subscribeToStream,
  type AnalyticsEvent,
  type AnalyticsStats,
  type MinutelyStat,
} from '../lib/api';
import {
  StatsCards,
  EventChart,
  MinutelyChart,
  LiveFeed,
  FireEventPanel,
} from '../features/analytics';

const MAX_FEED = 30;

export function Dashboard() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<AnalyticsStats | null>(null);
  const [liveEvents, setLiveEvents] = useState<AnalyticsEvent[]>([]);
  const [minutelyData, setMinutelyData] = useState<MinutelyStat[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);

  const refreshStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const [s, m] = await Promise.all([fetchStats(), fetchMinutelyStats(60)]);
      setStats(s);
      setMinutelyData(m);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRecent().then((events) =>
      setLiveEvents(events.slice(0, MAX_FEED)),
    );
    void refreshStats();
  }, [refreshStats]);

  useEffect(() => {
    const unsubscribe = subscribeToStream((event) => {
      setLiveEvents((prev) => {
        if (prev.some((e) => e.eventId === event.eventId)) return prev;
        return [event, ...prev].slice(0, MAX_FEED);
      });
      setTimeout(() => {
        void refreshStats();
      }, 2000);
    });
    return unsubscribe;
  }, [refreshStats]);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 py-8">
      {/* Example: per-page SEO. This is the app dashboard, so it's marked
          noindex. On a public page, drop the noindex and add a `path`. */}
      <Seo title={t('analytics.title')} noindex />
      <header className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-2xl font-bold text-heading">
          {t('analytics.title')}
        </h1>
        <p className="flex-1 text-xs text-muted">{t('analytics.subtitle')}</p>
        <button
          className="ml-auto cursor-pointer rounded-md border border-edge bg-raised px-4 py-1.5 text-[13px] text-soft transition-colors hover:bg-edge/40"
          onClick={() => {
            void refreshStats();
          }}
        >
          {t('analytics.refreshStats')}
        </button>
      </header>

      <StatsCards stats={stats} loading={statsLoading} />

      <div className="grid grid-cols-[1fr_380px] gap-4 max-[900px]:grid-cols-1">
        <div className="min-w-0">
          <EventChart data={stats?.byType ?? []} />
        </div>
        <div className="min-w-0">
          <FireEventPanel
            onEventFired={() => {
              void refreshStats();
            }}
          />
        </div>
      </div>

      <MinutelyChart data={minutelyData} />

      <LiveFeed events={liveEvents} />
    </div>
  );
}
