import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HEADERS, CLIENT_HEADER_VALUE } = require('../../../dist/index.js');

test('header names are lowercase and unique', () => {
  const names = Object.values(HEADERS);
  for (const name of names) assert.equal(name, name.toLowerCase(), name);
  assert.equal(new Set(names).size, names.length);
});

test('names the headers the contracts rely on', () => {
  assert.equal(HEADERS.TENANT, 'x-tenant-id');
  assert.equal(HEADERS.TRACEPARENT, 'traceparent');
  assert.equal(HEADERS.REQUEST_ID, 'x-request-id');
  assert.equal(HEADERS.CLIENT, 'x-tropis-client');
  assert.equal(CLIENT_HEADER_VALUE, '1');
});
