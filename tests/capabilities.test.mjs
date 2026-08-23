// Level 2 Task 6: capability schema validation, listing and lookup.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_CAPABILITIES,
  CapabilityError,
  agentsForCapability,
  createCapability,
  listCapabilities,
} from '../core/capabilities.mjs';

test('createCapability rejects empty / malformed input', () => {
  assert.throws(() => createCapability(null), CapabilityError);
  assert.throws(() => createCapability({}), (err) => err.code === 'CAP_ID_INVALID');
  assert.throws(() => createCapability({ id: 'coding', category: 'd', description: '' }), (err) => err.code === 'CAP_DESCRIPTION_INVALID');
});

test('createCapability returns a frozen plain object', () => {
  const cap = createCapability({ id: 'review', category: 'quality', description: 'review code', requiredTools: ['git'] });
  assert.equal(cap.id, 'review');
  assert.deepEqual([...cap.requiredTools], ['git']);
  assert.equal(Object.isFrozen(cap), true);
  assert.equal(Object.isFrozen(cap.requiredTools), true);
});

test('listCapabilities rejects duplicates and sorts by id', () => {
  const list = listCapabilities([
    { id: 'zeta', category: 'a', description: 'z' },
    { id: 'alpha', category: 'a', description: 'a' },
    { id: 'mu', category: 'a', description: 'm' },
  ]);
  assert.deepEqual(list.map((c) => c.id), ['alpha', 'mu', 'zeta']);
  assert.throws(() => listCapabilities([
    { id: 'a', category: 'a', description: 'a' },
    { id: 'a', category: 'b', description: 'b' },
  ]), (err) => err.code === 'CAP_DUPLICATE');
});

test('agentsForCapability returns exactly the agents with the capability, sorted by id', () => {
  const agents = [
    { id: 'zeta', capabilities: ['review'] },
    { id: 'alpha', capabilities: ['review', 'coding'] },
    { id: 'mu', capabilities: ['coding'] },
  ];
  assert.deepEqual(agentsForCapability('review', agents).map((a) => a.id), ['alpha', 'zeta']);
  assert.deepEqual(agentsForCapability('none', agents), []);
});

test('BUILTIN_CAPABILITIES covers the contract-verifier nodes used by Task 1 graphs', () => {
  const ids = new Set(BUILTIN_CAPABILITIES.map((c) => c.id));
  for (const required of ['coding', 'backend_development', 'frontend_development', 'testing']) {
    assert.ok(ids.has(required), `builtin capability ${required} is missing`);
  }
});
