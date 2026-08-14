import { useTranslation } from 'react-i18next';
import { useTrackingInsights } from '../state/tanstack/useTrackingQuery';
import {
  TopPagesTable,
  EventsByNameChart,
  DailyUniquesTable,
  RecentEventsTable,
} from '../features/behavior';

export function BehaviorPage() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useTrackingInsights(7);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-2xl font-bold text-heading">
          {t('behavior.title')}
        </h1>
        <p className="flex-1 text-xs text-muted">{t('behavior.subtitle')}</p>
        <button
          className="ml-auto cursor-pointer rounded-md border border-edge bg-raised px-4 py-1.5 text-[13px] text-soft transition-colors hover:bg-edge/40"
          onClick={() => {
            void refetch();
          }}
        >
          {t('common.refresh')}
        </button>
      </header>

      {isError && (
        <div className="rounded-xl border border-border bg-card p-5 max-md:p-3.5">
          <p className="py-6 text-center text-[13px] text-muted">
            {t('behavior.loadFailed')}
          </p>
        </div>
      )}

      <div className="grid grid-cols-[1fr_380px] gap-4 max-[900px]:grid-cols-1">
        <div className="min-w-0">
          <TopPagesTable data={data} isLoading={isLoading} />
        </div>
        <div className="min-w-0">
          <EventsByNameChart data={data} isLoading={isLoading} />
        </div>
      </div>

      <DailyUniquesTable data={data} isLoading={isLoading} />

      <RecentEventsTable data={data} isLoading={isLoading} />
    </div>
  );
}
