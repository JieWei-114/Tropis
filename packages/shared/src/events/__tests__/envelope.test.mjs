import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createEventEnvelope,
  envelopeToProperties,
  envelopeFromProperties,
  isStructuredEnvelope,
  isConformingEventType,
  EVENT_TYPES,
} = require('../../../dist/index.js');

const defaults = {
  id: 'generated-id',
  source: '/tropis/backend',
  type: 'tropis.message.published',
  time: '2026-09-30T00:00:00.000Z',
};

test('builds the envelope from explicit attributes only', () => {
  const data = { eventId: 'ignored', tenantId: 'ignored', userId: 'u' };
  const env = createEventEnvelope(data, {
    ...defaults,
    tenantid: 'acme',
    subject: 'user-9',
    traceparent: '00-a-b-01',
  });
  assert.equal(env.specversion, '1.0');
  assert.equal(env.id, 'generated-id');
  assert.equal(env.type, 'tropis.message.published');
  assert.equal(env.subject, 'user-9');
  assert.equal(env.tenantid, 'acme');
  assert.equal(env.time, defaults.time);
  assert.equal(env.datacontenttype, 'application/json');
  assert.equal(env.schemaversion, '1');
  assert.equal(env.traceparent, '00-a-b-01');
  assert.equal(env.data, data);
});

test('leaves unset optional attributes out', () => {
  const env = createEventEnvelope({ events: [] }, defaults);
  assert.equal('tenantid' in env, false);
  assert.equal('subject' in env, false);
  assert.equal('traceparent' in env, false);
});

test('binary-mode properties round-trip every attribute', () => {
  const env = createEventEnvelope(
    { a: 1 },
    {
      ...defaults,
      id: 'e',
      type: 'user.account.created',
      subject: 's',
      tenantid: 'acme',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'k=v',
    },
  );
  const props = envelopeToProperties(env);
  assert.equal(props.ce_id, 'e');
  assert.equal(props.ce_specversion, '1.0');
  assert.equal(props.traceparent, env.traceparent);
  assert.equal(props.ce_data, undefined);
  assert.deepEqual(envelopeFromProperties(props, env.data), env);
});

test('messages without CloudEvents properties yield no envelope', () => {
  assert.equal(envelopeFromProperties({}, {}), undefined);
  assert.equal(
    envelopeFromProperties(
      { ce_specversion: '0.3', ce_id: 'x', ce_type: 't' },
      {},
    ),
    undefined,
  );
});

test('recognises structured-mode bodies', () => {
  assert.ok(isStructuredEnvelope(createEventEnvelope({}, defaults)));
  assert.ok(!isStructuredEnvelope({ eventId: 'x' }));
  assert.ok(!isStructuredEnvelope(null));
});

test('event type naming rule', () => {
  assert.ok(isConformingEventType('user.account.created'));
  assert.ok(isConformingEventType('billing.invoice.paid'));
  assert.ok(isConformingEventType('outbox.row-batch.dead-lettered'));
  assert.ok(!isConformingEventType('user.created'));
  assert.ok(!isConformingEventType('page_view'));
  assert.ok(!isConformingEventType('user.account.create'));
  assert.ok(!isConformingEventType('User.Account.Created'));
});

test('the user events are named identity.user.<past-tense>', () => {
  assert.equal(EVENT_TYPES.USER_CREATED, 'identity.user.created');
  assert.equal(EVENT_TYPES.USER_UPDATED, 'identity.user.updated');
  assert.equal(EVENT_TYPES.USER_DELETED, 'identity.user.deleted');
});

test('every event type conforms to the naming rule', () => {
  for (const type of Object.values(EVENT_TYPES)) {
    assert.ok(isConformingEventType(type), type);
  }
});

test('legacy names resolve to a current event type', () => {
  const {
    LEGACY_EVENT_TYPES,
    canonicalEventType,
  } = require('../../../dist/index.js');
  assert.deepEqual(Object.keys(LEGACY_EVENT_TYPES).sort(), [
    'user.created',
    'user.deleted',
    'user.updated',
  ]);
  for (const [legacy, current] of Object.entries(LEGACY_EVENT_TYPES)) {
    assert.ok(Object.values(EVENT_TYPES).includes(current), legacy);
    assert.equal(canonicalEventType(legacy), current);
  }
  assert.equal(
    canonicalEventType(EVENT_TYPES.USER_UPDATED),
    EVENT_TYPES.USER_UPDATED,
  );
  assert.equal(canonicalEventType('toString'), 'toString');
  assert.equal(
    canonicalEventType('billing.invoice.paid'),
    'billing.invoice.paid',
  );
});

test('dataschema and datacontenttype round-trip in binary mode', () => {
  const env = createEventEnvelope(undefined, {
    ...defaults,
    dataschema: 'https://schemas.tropis.dev/tropis.message.published/1',
    datacontenttype: 'application/octet-stream',
  });
  assert.equal(env.datacontenttype, 'application/octet-stream');
  const props = envelopeToProperties(env);
  assert.equal(props.ce_dataschema, env.dataschema);
  assert.equal(props.ce_datacontenttype, 'application/octet-stream');
  assert.deepEqual(envelopeFromProperties(props, undefined), env);
});

test('the source is never empty', () => {
  const { UNKNOWN_EVENT_SOURCE } = require('../../../dist/index.js');
  assert.equal(
    createEventEnvelope({}, { ...defaults, source: '' }).source,
    UNKNOWN_EVENT_SOURCE,
  );
  const props = envelopeToProperties(createEventEnvelope({}, defaults));
  delete props.ce_source;
  assert.equal(envelopeFromProperties(props, {}).source, UNKNOWN_EVENT_SOURCE);
});
