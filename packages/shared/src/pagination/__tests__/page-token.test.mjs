import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  encodeOffsetPageToken,
  decodeOffsetPageToken,
  resolvePageSize,
} = require('../../../dist/index.js');

test('a page token round-trips its offset and is url-safe', () => {
  for (const offset of [0, 1, 20, 99999]) {
    const token = encodeOffsetPageToken(offset);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.equal(decodeOffsetPageToken(token), offset);
  }
});

test('an empty token is the first page', () => {
  assert.equal(decodeOffsetPageToken(''), 0);
});

test('a token the server did not issue is rejected', () => {
  assert.equal(decodeOffsetPageToken('not a token'), undefined);
  assert.equal(decodeOffsetPageToken(btoa('x:5')), undefined);
  assert.equal(decodeOffsetPageToken(btoa('o:-1')), undefined);
  assert.throws(() => encodeOffsetPageToken(-1), RangeError);
});

test('page sizes are clamped', () => {
  assert.equal(resolvePageSize(0), 20);
  assert.equal(resolvePageSize(undefined, 5), 5);
  assert.equal(resolvePageSize(500), 100);
  assert.equal(resolvePageSize(7, 20, 50), 7);
  assert.equal(resolvePageSize(-3, 10, 50), 10);
});
