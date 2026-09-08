import { useTranslation } from 'react-i18next';
import type { AnalyticsEvent } from '../../../lib/api';
import { eventColor } from '../eventColors';

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
        live
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
                className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white"
                style={{ background: eventColor(e.eventType) }}
              >
                {e.eventType}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-body">
                {e.userId}
              </span>
              <span className="shrink-0 text-[11px] whitespace-nowrap text-faint">
                {new Date(e.timestamp).toLocaleTimeString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
