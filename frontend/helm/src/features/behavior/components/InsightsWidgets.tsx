/**
 * BEHAVIOR FEATURE — dashboard widgets for tracking insights.
 * Pure presentational: receive `data`/`isLoading` from the page (which owns
 * the useTrackingInsights query) and render tables/bars.
 */
import { useTranslation } from 'react-i18next';
import type { useTrackingInsights } from '../../../state/tanstack/useTrackingQuery';

type Insights = NonNullable<ReturnType<typeof useTrackingInsights>['data']>;

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface WidgetProps {
  data?: Insights;
  isLoading: boolean;
}

export function TopPagesTable({ data, isLoading }: WidgetProps) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-border bg-card p-5 max-md:p-3.5">
      <h3 className="mb-4 text-sm font-semibold text-body">
        {t('behavior.topPages')}
      </h3>
      <div className="overflow-x-auto rounded-xl border border-border max-md:max-w-full">
        <table className="w-full border-collapse text-[13px] max-md:min-w-[560px] [&_tbody_tr]:border-b [&_tbody_tr]:border-border-soft [&_tbody_tr:hover]:bg-surface [&_tbody_tr:last-child]:border-b-0 [&_td]:px-4 [&_td]:py-[11px] [&_td]:align-middle [&_td]:text-body">
          <thead className="bg-surface">
            <tr>
              <th className="border-b border-border px-4 py-[11px] text-left text-[11px] font-semibold tracking-[0.5px] text-muted uppercase">
                {t('behavior.table.page')}
              </th>
              <th className="border-b border-border px-4 py-[11px] text-left text-[11px] font-semibold tracking-[0.5px] text-muted uppercase">
                {t('behavior.table.views')}
              </th>
            </tr>
          </thead>
          <tbody>
            {(data?.topPages ?? []).map((p) => (
              <tr key={p.page}>
                <td className="font-mono text-xs text-primary-soft">
                  {p.page}
                </td>
                <td>{p.count}</td>
              </tr>
            ))}
            {!isLoading && (data?.topPages.length ?? 0) === 0 && (
              <tr>
                <td
                  colSpan={2}
                  className="py-6 text-center text-[13px] text-muted"
                >
                  {t('behavior.noPageViews')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function EventsByNameChart({ data, isLoading }: WidgetProps) {
  const { t } = useTranslation();
  const maxEventCount = Math.max(
    1,
    ...(data?.eventsByName.map((e) => e.count) ?? []),
  );
  return (
    <div className="rounded-xl border border-border bg-card p-5 max-md:p-3.5">
      <h3 className="mb-4 text-sm font-semibold text-body">
        {t('behavior.eventsByName')}
      </h3>
      {(data?.eventsByName ?? []).map((e) => (
        <div key={e.eventName} className="mb-2.5">
          <div className="mb-1 flex justify-between text-xs text-body">
            <span className="font-mono text-xs text-primary-soft">
              {e.eventName}
            </span>
            <span>{e.count}</span>
          </div>
          <div className="h-2 rounded bg-border-soft">
            <div
              className="h-2 rounded bg-primary"
              style={{ width: `${(e.count / maxEventCount) * 100}%` }}
            />
          </div>
        </div>
      ))}
      {!isLoading && (data?.eventsByName.length ?? 0) === 0 && (
        <p className="py-6 text-center text-[13px] text-muted">
          {t('behavior.noEvents')}
        </p>
      )}
    </div>
  );
}

export function DailyUniquesTable({ data, isLoading }: WidgetProps) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-border bg-card p-5 max-md:p-3.5">
      <h3 className="mb-4 text-sm font-semibold text-body">
        {t('behavior.dailyUniques')}
      </h3>
      <div className="overflow-x-auto rounded-xl border border-border max-md:max-w-full">
        <table className="w-full border-collapse text-[13px] max-md:min-w-[560px] [&_tbody_tr]:border-b [&_tbody_tr]:border-border-soft [&_tbody_tr:hover]:bg-surface [&_tbody_tr:last-child]:border-b-0 [&_td]:px-4 [&_td]:py-[11px] [&_td]:align-middle [&_td]:text-body">
          <thead className="bg-surface">
            <tr>
              <th className="border-b border-border px-4 py-[11px] text-left text-[11px] font-semibold tracking-[0.5px] text-muted uppercase">
                {t('behavior.table.day')}
              </th>
              <th className="border-b border-border px-4 py-[11px] text-left text-[11px] font-semibold tracking-[0.5px] text-muted uppercase">
                {t('behavior.table.uniques')}
              </th>
            </tr>
          </thead>
          <tbody>
            {(data?.dailyUniques ?? []).map((d) => (
              <tr key={d.day}>
                <td className="font-mono text-xs text-primary-soft">{d.day}</td>
                <td>{d.uniques}</td>
              </tr>
            ))}
            {!isLoading && (data?.dailyUniques.length ?? 0) === 0 && (
              <tr>
                <td
                  colSpan={2}
                  className="py-6 text-center text-[13px] text-muted"
                >
                  {t('behavior.noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RecentEventsTable({ data, isLoading }: WidgetProps) {
  const { t } = useTranslation();
  return (
    <div className="max-h-80 overflow-y-auto rounded-xl border border-border bg-card p-5 max-md:p-3.5">
      <h3 className="mb-4 text-sm font-semibold text-body">
        {t('behavior.recentEvents')}
      </h3>
      <div className="overflow-x-auto rounded-xl border border-border max-md:max-w-full">
        <table className="w-full border-collapse text-[13px] max-md:min-w-[560px] [&_tbody_tr]:border-b [&_tbody_tr]:border-border-soft [&_tbody_tr:hover]:bg-surface [&_tbody_tr:last-child]:border-b-0 [&_td]:px-4 [&_td]:py-[11px] [&_td]:align-middle [&_td]:text-body">
          <thead className="bg-surface">
            <tr>
              <th className="border-b border-border px-4 py-[11px] text-left text-[11px] font-semibold tracking-[0.5px] text-muted uppercase">
                {t('behavior.table.event')}
              </th>
              <th className="border-b border-border px-4 py-[11px] text-left text-[11px] font-semibold tracking-[0.5px] text-muted uppercase">
                {t('behavior.table.page')}
              </th>
              <th className="border-b border-border px-4 py-[11px] text-left text-[11px] font-semibold tracking-[0.5px] text-muted uppercase">
                {t('behavior.table.user')}
              </th>
              <th className="border-b border-border px-4 py-[11px] text-left text-[11px] font-semibold tracking-[0.5px] text-muted uppercase">
                {t('behavior.table.session')}
              </th>
              <th className="border-b border-border px-4 py-[11px] text-left text-[11px] font-semibold tracking-[0.5px] text-muted uppercase">
                {t('behavior.table.when')}
              </th>
            </tr>
          </thead>
          <tbody>
            {(data?.recent ?? []).map((e) => (
              <tr key={e.eventId}>
                <td className="font-mono text-xs text-primary-soft">
                  {e.eventName}
                </td>
                <td className="font-mono text-xs text-primary-soft">
                  {e.page}
                </td>
                <td className="font-mono text-xs text-primary-soft">
                  {e.userId || `${e.anonymousId.slice(0, 8)}… (anon)`}
                </td>
                <td className="font-mono text-xs text-primary-soft">
                  {e.sessionId.slice(0, 8)}…
                </td>
                <td>{timeAgo(e.timestamp)}</td>
              </tr>
            ))}
            {!isLoading && (data?.recent.length ?? 0) === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="py-6 text-center text-[13px] text-muted"
                >
                  {t('behavior.noRecent')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
