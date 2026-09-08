import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ANALYTICS_EVENT_TYPES, TRACKING_EVENTS } from '@tropis/shared';
import { fireEvent, type EventType } from '../../../lib/api';
import { tracker } from '../../../lib/tracking';
import { eventColor } from '../eventColors';

const EVENT_TYPES: { type: EventType; labelKey: string; color: string }[] = [
  {
    type: ANALYTICS_EVENT_TYPES.PAGE_VIEW,
    labelKey: 'analytics.events.pageView',
    color: eventColor(ANALYTICS_EVENT_TYPES.PAGE_VIEW),
  },
  {
    type: ANALYTICS_EVENT_TYPES.BUTTON_CLICK,
    labelKey: 'analytics.events.buttonClick',
    color: eventColor(ANALYTICS_EVENT_TYPES.BUTTON_CLICK),
  },
  {
    type: ANALYTICS_EVENT_TYPES.API_CALL,
    labelKey: 'analytics.events.apiCall',
    color: eventColor(ANALYTICS_EVENT_TYPES.API_CALL),
  },
  {
    type: ANALYTICS_EVENT_TYPES.ERROR,
    labelKey: 'analytics.events.error',
    color: eventColor(ANALYTICS_EVENT_TYPES.ERROR),
  },
  {
    type: ANALYTICS_EVENT_TYPES.PURCHASE,
    labelKey: 'analytics.events.purchase',
    color: eventColor(ANALYTICS_EVENT_TYPES.PURCHASE),
  },
];

interface Props {
  onEventFired: () => void;
}

export function FireEventPanel({ onEventFired }: Props) {
  const { t } = useTranslation();
  const [userId, setUserId] = useState('user_demo');
  const [firing, setFiring] = useState<EventType | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);

  const handleFire = async (type: EventType) => {
    setFiring(type);
    tracker.track(TRACKING_EVENTS.BUTTON_CLICK.name, {
      label: 'Fire Event',
      eventType: type,
    });
    try {
      await fireEvent(type, userId, { source: 'dashboard', ts: Date.now() });
      setLastSent(type);
      onEventFired();
    } catch {
      setLastSent(`failed: ${type}`);
    } finally {
      setFiring(null);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 max-md:p-3.5">
      <h3 className="text-sm font-semibold text-body">
        {t('analytics.fireEvents')}
      </h3>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-muted" htmlFor="fire-event-user-id">
          {t('analytics.userId')}
        </label>
        <input
          id="fire-event-user-id"
          className="rounded-md border border-border bg-input px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder={t('analytics.userIdPlaceholder')}
        />
      </div>

      <div className="flex flex-col gap-2">
        {EVENT_TYPES.map(({ type, labelKey, color }) => (
          <button
            key={type}
            className="cursor-pointer rounded-lg border bg-transparent px-3.5 py-2.5 text-left text-[13px] font-medium transition-opacity enabled:hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: color, color }}
            disabled={firing !== null}
            onClick={() => {
              void handleFire(type);
            }}
          >
            {firing === type ? t('analytics.sending') : t(labelKey)}
          </button>
        ))}
      </div>

      {lastSent && (
        <p className="fire-status rounded-md border border-success/25 bg-success/10 px-3 py-2 text-xs text-success">
          {t('analytics.sent')} <strong>{lastSent}</strong>
          &nbsp;→ MongoDB → Pulsar → Processor → ClickHouse
        </p>
      )}
    </div>
  );
}
