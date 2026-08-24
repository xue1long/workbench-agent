// tests/adapter-registry.test.mjs
//
// Tests for the adapter registry surface added to core/adapters.mjs.
// The registry lets other modules obtain adapter instances by id
// without importing concrete adapter classes. Concrete adapters
// register themselves once at module load (Task 3); here we just
// drive the registry directly to confirm its contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerAdapter,
  getAdapter,
  listAdapters,
  _resetAdaptersForTests,
} from '../core/adapters.mjs';

class FakeGitAdapter {
  constructor(opts = {}) {
    this.opts = opts;
    this.kind = 'fake-git';
  }
}

test.beforeEach(() => {
  _resetAdaptersForTests();
});

test('registerAdapter stores a factory keyed by id', () => {
  registerAdapter({ id: 'fake-git', kind: 'tool', factory: (opts) => new FakeGitAdapter(opts) });
  assert.deepEqual(listAdapters(), ['fake-git']);
});

test('getAdapter instantiates from the factory', () => {
  registerAdapter({ id: 'fake-git', factory: (opts) => new FakeGitAdapter(opts) });
  const a = getAdapter('fake-git', { workspace: '/tmp' });
  assert.ok(a instanceof FakeGitAdapter);
  assert.equal(a.opts.workspace, '/tmp');
});

test('registerAdapter rejects duplicate ids', () => {
  registerAdapter({ id: 'fake-git', factory: () => new FakeGitAdapter() });
  assert.throws(
    () => registerAdapter({ id: 'fake-git', factory: () => new FakeGitAdapter() }),
    /already registered/
  );
});

test('getAdapter throws AdapterError on unknown id', () => {
  assert.throws(() => getAdapter('nope'), /no adapter registered for: nope/);
});

test('listAdapters returns sorted ids', () => {
  registerAdapter({ id: 'b', factory: () => ({}) });
  registerAdapter({ id: 'a', factory: () => ({}) });
  registerAdapter({ id: 'c', factory: () => ({}) });
  assert.deepEqual(listAdapters(), ['a', 'b', 'c']);
});

test('_resetAdaptersForTests clears the registry', () => {
  registerAdapter({ id: 'fake-git', factory: () => new FakeGitAdapter() });
  assert.equal(listAdapters().length, 1);
  _resetAdaptersForTests();
  assert.equal(listAdapters().length, 0);
});

test('registerAdapter validates required fields', () => {
  assert.throws(() => registerAdapter({}), /id is required/);
  assert.throws(() => registerAdapter({ id: 'x' }), /factory must be a function/);
  assert.throws(() => registerAdapter({ id: 'x', factory: 'not-a-fn' }), /factory must be a function/);
});

test('existing BaseAdapter / adapterResult / okResult / applyResult / REFUSE_ACTIONS exports are unchanged', async () => {
  const mod = await import('../core/adapters.mjs');
  assert.equal(typeof mod.BaseAdapter, 'function');
  assert.equal(typeof mod.adapterResult, 'function');
  assert.equal(typeof mod.okResult, 'function');
  assert.equal(typeof mod.applyResult, 'function');
  assert.equal(typeof mod.planOne, 'function');
  assert.ok(mod.REFUSE_ACTIONS instanceof Set);
  assert.ok(mod.REFUSE_ACTIONS.has('force-push'));
});
