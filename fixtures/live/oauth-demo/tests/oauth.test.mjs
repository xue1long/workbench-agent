import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorizationUrl, validateCallback } from '../src/server.mjs';

test('buildAuthorizationUrl produces a deterministic URL with state', () => {
  const url = buildAuthorizationUrl({ clientId: 'cid', redirectUri: 'https://app.example/cb', state: 'abc' });
  assert.match(url, /^https:\/\/auth\.example\.com\/authorize\?/);
  assert.match(url, /client_id=cid/);
  assert.match(url, /state=abc/);
});

test('validateCallback accepts matching state and rejects mismatches', () => {
  assert.equal(validateCallback({ state: 'abc', receivedState: 'abc' }), true);
  assert.equal(validateCallback({ state: 'abc', receivedState: 'xyz' }), false);
});

test('validateCallback rejects empty receivedState', () => {
  assert.equal(validateCallback({ state: 'abc', receivedState: '' }), false);
});
