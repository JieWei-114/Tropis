import { useTranslation } from 'react-i18next';
import type { AnalyticsStats } from '../../../lib/api';
import { Card } from '@/components/ui/card';

interface Props {
  stats: AnalyticsStats | null;
  loading: boolean;
}

// `.stat-card` is an e2e hook — keep it on every card.
const CARD = 'stat-card flex flex-col gap-2 rounded-xl p-5 max-md:p-3.5';
const LABEL = 'text-xs text-muted';
const VALUE = 'font-bold text-heading';

export function StatsCards({ stats, loading }: Props) {
  const { t } = useTranslation();
  const lastSeen = stats?.byType.reduce(
    (max, t) => Math.max(max, t.lastSeen),
    0,
  );

  return (
    <div className="grid grid-cols-4 gap-4 max-[480px]:grid-cols-1 max-md:grid-cols-2">
      <Card className={`${CARD} border-border`}>
        <span className={LABEL}>{t('analytics.stats.totalEvents')}</span>
        <span className={`${VALUE} text-[32px]`}>
          {loading ? '…' : (stats?.totalEvents ?? 0).toLocaleString()}
        </span>
      </Card>

      <Card className={`${CARD} border-border`}>
        <span className={LABEL}>{t('analytics.stats.uniqueTypes')}</span>
        <span className={`${VALUE} text-[32px]`}>
          {loading ? '…' : (stats?.byType.length ?? 0)}
        </span>
      </Card>

      <Card className={`${CARD} border-border`}>
        <span className={LABEL}>{t('analytics.stats.lastEvent')}</span>
        <span className={`${VALUE} text-xl`}>
          {loading
            ? '…'
            : lastSeen
              ? new Date(lastSeen).toLocaleTimeString()
              : '—'}
        </span>
      </Card>

      <Card
        className={`${CARD} ${stats?.fromCache ? 'border-success/25' : 'border-primary/25'}`}
      >
        <span className={LABEL}>{t('analytics.stats.redisCache')}</span>
        <span className={`${VALUE} text-xl`}>
          {loading
            ? '…'
            : stats?.fromCache
              ? t('analytics.stats.hit')
              : t('analytics.stats.miss')}
        </span>
        {stats && !loading && (
          <span className="text-[11px] text-faint">
            {t('analytics.stats.cachedAt', {
              time: new Date(stats.cachedAt).toLocaleTimeString(),
            })}
          </span>
        )}
      </Card>
    </div>
  );
}
