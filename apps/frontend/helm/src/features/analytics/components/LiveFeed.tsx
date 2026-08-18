import { useTranslation } from 'react-i18next';
import { ANALYTICS_EVENT_TYPES } from '@tropis/shared';
import type { AnalyticsEvent } from '../../../lib/api';

const TYPE_COLOR: Record<string, string> = {
  [ANALYTICS_EVENT_TYPES.PAGE_VIEW]: '#6366f1',
  [ANALYTICS_EVENT_TYPES.BUTTON_CLICK]: '#22c55e',
  [ANALYTICS_EVENT_TYPES.API_CALL]: '#f59e0b',
  [ANALYTICS_EVENT_TYPES.ERROR]: '#ef4444',
  [ANALYTICS_EVENT_TYPES.PURCHASE]: '#14b8a6',
};

interface Props {
  events: AnalyticsEvent[];
}

export function LiveFeed({ events }: Props) {
  const { t } = useTranslation();
  return (
    <div className="max-h-80 overflow-y-auto rounded-xl border border-border bg-card p-5 max-md:p-3.5">
      <h3 className="mb-4 text-sm font-semibold text-body">
        {t('analytics.liveFeed')}{' '}
        <span className="ml-1.5 inline-block h-2 w-2 animate-blink rounded-full bg-success" />{' '}
        SSE
      </h3>
      {events.length === 0 ? (
        <p className="py-3 text-[13px] text-faint">
          {t('analytics.waitingForEvents')}
        </p>
      ) : (
        <ul className="flex list-none flex-col gap-2">
          {events.map((e) => (
            <li
              key={e.eventId}
              className="feed-item flex animate-fade-in items-center gap-2.5 rounded-md bg-background px-2.5 py-2"
            >
              <span
                className="rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white"
                style={{ background: TYPE_COLOR[e.eventType] ?? '#6366f1' }}
              >
                {e.eventType}
              </span>
              <span className="flex-1 text-xs text-body">{e.userId}</span>
              <span className="text-[11px] whitespace-nowrap text-faint">
                {new Date(e.timestamp).toLocaleTimeString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
