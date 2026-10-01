/**
 * The event envelope, aligned with CloudEvents 1.0. Every message published
 * through the backend messaging port is described by one.
 *
 * Wire format: CloudEvents binary content mode. The attributes travel as
 * message properties (Pulsar) or headers (Kafka) named `ce_<attribute>`, the
 * W3C `traceparent`/`tracestate` travel under their own names, and the message
 * body is `data` unchanged, so consumers that only read the body (the Flink
 * job) need no envelope code. A body sent in structured mode
 * (`application/cloudevents+json`, the whole envelope as JSON) is accepted too
 * and unwrapped on receipt.
 *
 * Attribute rules:
 * - `type` is `<domain>.<entity>.<past-tense-verb>`, e.g. `user.account.created`.
 * - `time` is ISO 8601 UTC; `id` is an opaque string, unique per `source`,
 *   and stable across redeliveries so consumers can dedup on it.
 * - `schemaversion` is the version of the `data` schema for this `type`,
 *   bumped on any breaking change to `data`; `dataschema`, when set, is the
 *   URI of that schema.
 * - `source` is never empty: an envelope built without one, or received
 *   without one, carries UNKNOWN_EVENT_SOURCE.
 * - `datacontenttype` describes `data` as sent: `application/json` for an
 *   object payload, `application/octet-stream` for raw bytes.
 */
export interface EventEnvelope<T = unknown> {
  specversion: '1.0';
  id: string;
  /** URI-reference of the producer, e.g. `/tropis/backend/outbox`. */
  source: string;
  type: string;
  time: string;
  /** The entity the event is about, e.g. the user id. */
  subject?: string;
  datacontenttype: EventDataContentType;
  /** URI of the schema `data` adheres to. */
  dataschema?: string;
  /** Owning tenant; absent on a platform-wide (global) event. */
  tenantid?: string;
  /** W3C traceparent of the producer when the event was published. */
  traceparent?: string;
  tracestate?: string;
  schemaversion: string;
  data: T;
}

export const EVENT_SPEC_VERSION = '1.0';
export const EVENT_DATA_CONTENT_TYPE = 'application/json';
export const EVENT_BINARY_CONTENT_TYPE = 'application/octet-stream';
export type EventDataContentType =
  | typeof EVENT_DATA_CONTENT_TYPE
  | typeof EVENT_BINARY_CONTENT_TYPE;
/** `source` of an event whose producer named none (a foreign message). */
export const UNKNOWN_EVENT_SOURCE = 'urn:tropis:unknown-source';
export const EVENT_STRUCTURED_CONTENT_TYPE = 'application/cloudevents+json';
export const DEFAULT_EVENT_SCHEMA_VERSION = '1';

/** Prefix of the binary-mode attribute properties/headers. */
export const EVENT_ATTRIBUTE_PREFIX = 'ce_';

/** Attributes carried as `ce_<name>` properties in binary mode. */
const BINARY_ATTRIBUTES = [
  'specversion',
  'id',
  'source',
  'type',
  'time',
  'subject',
  'datacontenttype',
  'dataschema',
  'tenantid',
  'schemaversion',
] as const;

/** `<domain>.<entity>.<past-tense-verb>`, lowercase, kebab within a segment. */
const EVENT_TYPE_PATTERN =
  /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*ed$/;

const IRREGULAR_PAST_TENSE = new Set(['sent', 'built', 'paid', 'lost']);

/**
 * Whether a type name follows `<domain>.<entity>.<past-tense>`. The past
 * tense check accepts `-ed` verbs plus a short list of irregular ones.
 */
export function isConformingEventType(type: string): boolean {
  if (EVENT_TYPE_PATTERN.test(type)) return true;
  const parts = type.split('.');
  return (
    parts.length === 3 &&
    parts.every((p) => /^[a-z][a-z0-9-]*$/.test(p)) &&
    IRREGULAR_PAST_TENSE.has(parts[2])
  );
}

/** The attributes of an envelope; everything but `data`. */
export interface EnvelopeAttributes {
  id: string;
  source: string;
  type: string;
  /** ISO 8601 UTC. */
  time: string;
  tenantid?: string;
  subject?: string;
  schemaversion?: string;
  dataschema?: string;
  /** Defaults to `application/json`. */
  datacontenttype?: EventDataContentType;
  traceparent?: string;
  tracestate?: string;
}

function contentType(value: string | undefined): EventDataContentType {
  return value === EVENT_BINARY_CONTENT_TYPE
    ? EVENT_BINARY_CONTENT_TYPE
    : EVENT_DATA_CONTENT_TYPE;
}

/** Builds the envelope of `data` from explicit attributes only. */
export function createEventEnvelope<T>(
  data: T,
  attributes: EnvelopeAttributes,
): EventEnvelope<T> {
  const envelope: EventEnvelope<T> = {
    specversion: EVENT_SPEC_VERSION,
    id: attributes.id,
    source: attributes.source || UNKNOWN_EVENT_SOURCE,
    type: attributes.type,
    time: attributes.time,
    datacontenttype: contentType(attributes.datacontenttype),
    schemaversion: attributes.schemaversion ?? DEFAULT_EVENT_SCHEMA_VERSION,
    data,
  };
  if (attributes.dataschema) envelope.dataschema = attributes.dataschema;
  if (attributes.tenantid) envelope.tenantid = attributes.tenantid;
  if (attributes.subject) envelope.subject = attributes.subject;
  if (attributes.traceparent) envelope.traceparent = attributes.traceparent;
  if (attributes.tracestate) envelope.tracestate = attributes.tracestate;
  return envelope;
}

/** Binary-mode properties for an envelope (everything except `data`). */
export function envelopeToProperties(
  envelope: EventEnvelope,
): Record<string, string> {
  const props: Record<string, string> = {};
  for (const attr of BINARY_ATTRIBUTES) {
    const value = envelope[attr];
    if (typeof value === 'string') {
      props[`${EVENT_ATTRIBUTE_PREFIX}${attr}`] = value;
    }
  }
  if (envelope.traceparent) props.traceparent = envelope.traceparent;
  if (envelope.tracestate) props.tracestate = envelope.tracestate;
  return props;
}

/**
 * Rebuilds the envelope from binary-mode properties and the decoded body.
 * Returns undefined when the message carries no CloudEvents attributes
 * (a foreign producer).
 */
export function envelopeFromProperties<T>(
  props: Readonly<Record<string, string | undefined>>,
  data: T,
): EventEnvelope<T> | undefined {
  const get = (attr: string) => props[`${EVENT_ATTRIBUTE_PREFIX}${attr}`];
  const id = get('id');
  const type = get('type');
  if (get('specversion') !== EVENT_SPEC_VERSION || !id || !type) {
    return undefined;
  }
  const envelope: EventEnvelope<T> = {
    specversion: EVENT_SPEC_VERSION,
    id,
    source: get('source') || UNKNOWN_EVENT_SOURCE,
    type,
    time: get('time') ?? '',
    datacontenttype: contentType(get('datacontenttype')),
    schemaversion: get('schemaversion') ?? DEFAULT_EVENT_SCHEMA_VERSION,
    data,
  };
  const dataschema = get('dataschema');
  if (dataschema) envelope.dataschema = dataschema;
  const tenantid = get('tenantid');
  if (tenantid) envelope.tenantid = tenantid;
  const subject = get('subject');
  if (subject) envelope.subject = subject;
  if (props.traceparent) envelope.traceparent = props.traceparent;
  if (props.tracestate) envelope.tracestate = props.tracestate;
  return envelope;
}

/** Whether a decoded body is a structured-mode envelope. */
export function isStructuredEnvelope(body: unknown): body is EventEnvelope {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    b.specversion === EVENT_SPEC_VERSION &&
    typeof b.id === 'string' &&
    typeof b.type === 'string' &&
    'data' in b
  );
}
