import { randomUUID } from 'crypto';
import { context, SpanKind, trace } from '@opentelemetry/api';
import {
  createEventEnvelope,
  envelopeFromProperties,
  envelopeToProperties,
  EVENT_BINARY_CONTENT_TYPE,
  EVENT_STRUCTURED_CONTENT_TYPE,
  EVENT_TYPES,
  isStructuredEnvelope,
  UNKNOWN_EVENT_SOURCE,
  type EventEnvelope,
} from '@tropis/shared';
import {
  injectTraceContext,
  recordSpanError,
  runInExtractedSpan,
  tracer,
} from '../../common/observability/propagation';
import { isTenantId } from '../../common/keyspace';
import { currentTenant, runInTenant } from '../../common/tenant/tenant.context';
import type { MessageHandler, PublishOptions } from './messaging.port';
import { consumerLabels, consumerMetrics } from './messaging.metrics';

/**
 * Wraps and unwraps the event envelope (packages/shared/src/events) and
 * carries W3C Trace Context across the broker. Every adapter publishes and
 * consumes through these two functions, so the wire format and the tracing
 * are the same whichever broker MESSAGING selects.
 *
 * Wire format: CloudEvents binary mode. The envelope attributes are
 * `ce_*` message properties/headers, `traceparent`/`tracestate` are their
 * own properties, and the body is the payload exactly as the publisher
 * passed it, so consumers that read only the body (the Flink job) need no
 * envelope code. A structured-mode body is unwrapped on receipt.
 *
 * Spans follow the OTel messaging conventions: a PRODUCER span
 * `publish <destination>` around the send, whose context is what the message
 * carries, and a CONSUMER span `process <destination>` around the handler,
 * a child of the producer span.
 */

export type MessagingSystem = 'pulsar' | 'kafka' | 'memory';

/** `source` attribute of events published by this backend. */
export const EVENT_SOURCE = '/tropis/backend';
/** Type of a message whose publisher named none. */
export const DEFAULT_EVENT_TYPE = EVENT_TYPES.MESSAGE_PUBLISHED;

export interface OutgoingMessage {
  data: Buffer;
  properties: Record<string, string>;
  envelope: EventEnvelope;
}

/** Short destination name for span names and attributes. */
export function destinationName(topic: string): string {
  return topic.replace(/^[a-z-]+:\/\//, '');
}

/**
 * Builds the wire message for `payload` inside a PRODUCER span and hands it
 * to `send`. The envelope attributes come from `opts.event`, with defaults
 * for the ones it leaves unset.
 */
export async function publishEnveloped(
  system: MessagingSystem,
  topic: string,
  payload: Buffer | object,
  opts: PublishOptions | undefined,
  send: (message: OutgoingMessage) => Promise<void>,
): Promise<void> {
  const destination = destinationName(topic);
  const span = tracer().startSpan(`publish ${destination}`, {
    kind: SpanKind.PRODUCER,
    attributes: {
      'messaging.system': system,
      'messaging.destination.name': destination,
      'messaging.operation.type': 'send',
      'messaging.operation.name': 'publish',
    },
  });
  const ctx = trace.setSpan(context.active(), span);
  try {
    const message = context.with(ctx, () =>
      encodeOutgoing(topic, payload, opts),
    );
    span.setAttribute('messaging.message.id', message.envelope.id);
    if (message.envelope.tenantid) {
      span.setAttribute('tenant.id', message.envelope.tenantid);
    }
    await context.with(ctx, () => send(message));
  } catch (err) {
    recordSpanError(span, err);
    throw err;
  } finally {
    span.end();
  }
}

/** The envelope and wire message for a payload, in the active context. */
export function encodeOutgoing(
  topic: string,
  payload: Buffer | object,
  opts?: PublishOptions,
): OutgoingMessage {
  const carrier = injectTraceContext({});
  const event = opts?.event ?? {};
  const isBuffer = Buffer.isBuffer(payload);
  const envelope = createEventEnvelope<unknown>(
    isBuffer ? undefined : payload,
    {
      id: event.id ?? randomUUID(),
      source: event.source ?? EVENT_SOURCE,
      type: event.type ?? DEFAULT_EVENT_TYPE,
      time: event.time ?? new Date().toISOString(),
      tenantid: event.tenantId ?? currentTenant(),
      subject: event.subject,
      schemaversion: event.schemaVersion,
      traceparent: carrier.traceparent,
      tracestate: carrier.tracestate,
      ...(isBuffer ? { datacontenttype: EVENT_BINARY_CONTENT_TYPE } : {}),
    },
  );
  const properties = {
    ...opts?.properties,
    ...envelopeToProperties(envelope),
  };
  return {
    data: isBuffer ? payload : Buffer.from(JSON.stringify(payload)),
    properties,
    envelope,
  };
}

export interface IncomingMessage {
  /** The body the handler receives (the envelope `data` when structured). */
  data: Buffer;
  envelope: EventEnvelope;
}

function parseJson(data: Buffer): unknown {
  try {
    return JSON.parse(data.toString()) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The envelope of a received message: from binary-mode properties, from a
 * structured-mode body, or, for a foreign message without either, a fresh
 * envelope with no tenant (whose handler then cannot read one).
 */
export function decodeIncoming(
  data: Buffer,
  properties: Readonly<Record<string, string | undefined>>,
): IncomingMessage {
  const structured =
    properties['content-type'] === EVENT_STRUCTURED_CONTENT_TYPE ||
    properties.ce_specversion === undefined;
  const parsed = parseJson(data);
  if (structured && isStructuredEnvelope(parsed)) {
    return {
      data: Buffer.from(JSON.stringify(parsed.data)),
      envelope: parsed,
    };
  }
  const body = parsed ?? data;
  const envelope =
    envelopeFromProperties(properties, body) ??
    createEventEnvelope(body, {
      id: randomUUID(),
      source: UNKNOWN_EVENT_SOURCE,
      type: DEFAULT_EVENT_TYPE,
      time: new Date().toISOString(),
      traceparent: properties.traceparent,
      tracestate: properties.tracestate,
    });
  return { data, envelope };
}

/**
 * Runs the handler for one received message inside a CONSUMER span that
 * continues the producer's trace, with the request context (trace id, tenant)
 * bound so its log records correlate, and inside the envelope's tenant
 * scope. A message without a valid tenant runs unscoped, so a handler that
 * reads the tenant fails (and the message is redelivered, then dead-lettered)
 * instead of acting on some other tenant. Rethrows the handler's error so
 * the adapter nacks.
 */
export function consumeEnveloped(
  system: MessagingSystem,
  topic: string,
  subscription: string,
  data: Buffer,
  properties: Readonly<Record<string, string | undefined>>,
  handler: MessageHandler,
): Promise<void> {
  const incoming = decodeIncoming(data, properties);
  const { envelope } = incoming;
  const destination = destinationName(topic);
  const carrier: Record<string, string | undefined> = {
    traceparent: properties.traceparent ?? envelope.traceparent,
    tracestate: properties.tracestate ?? envelope.tracestate,
  };
  return runInExtractedSpan(
    carrier,
    `process ${destination}`,
    {
      kind: SpanKind.CONSUMER,
      tenantId: envelope.tenantid,
      attributes: {
        'messaging.system': system,
        'messaging.destination.name': destination,
        'messaging.destination.subscription.name': subscription,
        'messaging.consumer.group.name': subscription,
        'messaging.operation.type': 'process',
        'messaging.operation.name': 'process',
        'messaging.message.id': envelope.id,
        'cloudevents.event_type': envelope.type,
      },
    },
    async () => {
      const metrics = consumerMetrics();
      const labels = consumerLabels(system, destination, subscription);
      const tenantId = envelope.tenantid;
      try {
        if (isTenantId(tenantId)) {
          await runInTenant(tenantId, () => handler(incoming.data, envelope));
        } else {
          await handler(incoming.data, envelope);
        }
      } catch (err) {
        metrics.failed.inc(labels);
        throw err;
      }
      metrics.processed.inc(labels);
    },
  );
}

/** Kafka header values (Buffer | string | array) as plain strings. */
export function headersToStrings(
  headers: Record<
    string,
    Buffer | string | (Buffer | string)[] | undefined
  > = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (v !== undefined) out[key] = v.toString();
  }
  return out;
}
