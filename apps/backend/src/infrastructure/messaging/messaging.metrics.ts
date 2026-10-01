import { counter } from '../../common/observability/metrics';

export const MESSAGING_PROCESSED_METRIC = 'tropis_messaging_processed_total';
export const MESSAGING_FAILED_METRIC = 'tropis_messaging_failed_total';
export const MESSAGING_DEAD_LETTERED_METRIC =
  'tropis_messaging_dead_lettered_total';

type ConsumerLabel = 'system' | 'destination' | 'subscription';

const LABELS: readonly ConsumerLabel[] = [
  'system',
  'destination',
  'subscription',
];

/**
 * Consumer throughput, per adapter, topic and subscription (both bounded:
 * topics and subscriptions are code constants). `failed` counts attempts,
 * so one message redelivered three times counts three.
 */
export function consumerMetrics() {
  return {
    processed: counter(
      MESSAGING_PROCESSED_METRIC,
      'Messages a consumer handled successfully',
      LABELS,
    ),
    failed: counter(
      MESSAGING_FAILED_METRIC,
      'Message handling attempts that failed and were nacked',
      LABELS,
    ),
    deadLettered: counter(
      MESSAGING_DEAD_LETTERED_METRIC,
      'Messages routed to the dead-letter topic after their last redelivery',
      LABELS,
    ),
  };
}

export function consumerLabels(
  system: string,
  destination: string,
  subscription: string,
): Record<ConsumerLabel, string> {
  return { system, destination, subscription };
}
