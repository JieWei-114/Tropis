import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  NATIVE_CLIENT_HEADER_VALUE,
  NATIVE_SESSION_ORIGINS,
  DEFAULT_NATIVE_OAUTH_REDIRECT,
  CLIENT_HEADER_VALUE,
} = require('../../../dist/index.js');

test('the native client value differs from the web one', () => {
  assert.equal(NATIVE_CLIENT_HEADER_VALUE, 'native');
  assert.notEqual(NATIVE_CLIENT_HEADER_VALUE, CLIENT_HEADER_VALUE);
});

test('native session origins are the shell origins only', () => {
  assert.deepEqual([...NATIVE_SESSION_ORIGINS].sort(), [
    'capacitor://localhost',
    'http://tauri.localhost',
    'https://localhost',
    'tauri://localhost',
  ]);
  assert.ok(!NATIVE_SESSION_ORIGINS.includes('http://localhost'));
});

test('the default OAuth return is a custom scheme', () => {
  assert.equal(DEFAULT_NATIVE_OAUTH_REDIRECT, 'tropis://auth/callback');
});
