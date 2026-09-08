import { ANALYTICS_EVENT_TYPES } from '@tropis/shared';

/**
 * One source of truth for the five event-type colours, as CSS-variable
 * references so charts, badges and the live feed all follow the active theme
 * (defined in index.css as --cat-*).
 */
const EVENT_COLOR: Record<string, string> = {
  [ANALYTICS_EVENT_TYPES.PAGE_VIEW]: 'var(--cat-pageview)',
  [ANALYTICS_EVENT_TYPES.BUTTON_CLICK]: 'var(--cat-click)',
  [ANALYTICS_EVENT_TYPES.API_CALL]: 'var(--cat-api)',
  [ANALYTICS_EVENT_TYPES.ERROR]: 'var(--cat-error)',
  [ANALYTICS_EVENT_TYPES.PURCHASE]: 'var(--cat-purchase)',
};

const EVENT_COLOR_FALLBACK = 'var(--primary)';

export const eventColor = (type: string): string =>
  EVENT_COLOR[type] ?? EVENT_COLOR_FALLBACK;
