import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ObservedState,
  ResourceState,
  AppliedState,
  AppliedStep,
  diffResource,
} from '../core/state.mjs';
import {
  BaseAdapter,
  FakeAdapter,
  AdapterError,
  planOne,
  okResult,
  applyResult,
  adapterResult,
  REFUSE_ACTIONS,
} from '../core/adapters.mjs';

// ---------- state.mjs -------------------------------------------------------

test('ResourceState normalizes version to string and rejects empty names', () => {
  const r = new ResourceState({ resource: 'node', version: 22, status: 'INSTALLED' });
  assert.equal(r.version, '22');
  assert.equal(r.status, 'INSTALLED');
  assert.throws(() => new ResourceState({ resource: '' }), TypeError);
});

test('ObservedState accepts Map, array of ResourceStates, and plain object', () => {
  const fromMap = new ObservedState(new Map([['node', new ResourceState({ resource: 'node', version: '22' })]]));
  assert.equal(fromMap.get('node').version, '22');

  const fromArr = new ObservedState([new ResourceState({ resource: 'python', version: '3.12' })]);
  assert.equal(fromArr.get('python').version, '3.12');

  const fromObj = new ObservedState({ uv: '0.4.18' });
  assert.equal(fromObj.get('uv').version, '0.4.18');
  assert.equal(fromObj.get('uv').status, 'INSTALLED');

  const nullVersion = new ObservedState({ node: null });
  assert.equal(nullVersion.get('node').status, 'MISSING');
});

test('ObservedState.set validates input and exposes toJSON', () => {
  const s = new ObservedState();
  s.set(new ResourceState({ resource: 'node', version: '22' }));
  assert.deepEqual(s.toJSON(), { node: { version: '22', status: 'INSTALLED', details: {} } });
  assert.throws(() => s.set({ resource: 'x' }), TypeError);
});

test('AppliedStep and AppliedState capture M2 lifecycle', () => {
  const step = new AppliedStep({ resource: 'node', action: 'INSTALL', version: '22', previous: null });
  assert.equal(step.status, 'APPLIED');
  assert.ok(step.at);
  const state = new AppliedState('MyWorkspace', [step]);
  assert.equal(state.get('node').version, '22');
  assert.deepEqual(state.toJSON().workspaceId, 'MyWorkspace');
});

test('diffResource covers INSTALL / SKIP / UPDATE', () => {
  assert.deepEqual(diffResource('22', null), { action: 'INSTALL', version: '22', previous: null });
  assert.deepEqual(diffResource('22', '22'), { action: 'SKIP', version: '22', previous: null });
  assert.deepEqual(diffResource('22', '20'), { action: 'UPDATE', version: '22', previous: '20' });
});

// ---------- adapters.mjs ----------------------------------------------------

test('adapterResult coerces booleans and keeps status intact', () => {
  const r = adapterResult({ success: 1, changed: 0, status: 'INSTALLED', message: 'ok' });
  assert.equal(r.success, true);
  assert.equal(r.changed, false);
  assert.equal(r.status, 'INSTALLED');
});

test('BaseAdapter refuses destructive actions by default', () => {
  const a = new BaseAdapter({ id: 'git' });
  for (const action of REFUSE_ACTIONS) {
    assert.throws(
      () => a._check(action),
      (err) => err instanceof AdapterError && err.code === 'ADAPTER_ACTION_REFUSED'
    );
  }
});

test('BaseAdapter rejects actions not in its allow-list', () => {
  const a = new BaseAdapter({ id: 'noop', allowedActions: new Set(['detect']) });
  assert.throws(() => a._check('install'), (err) => err.code === 'ADAPTER_ACTION_NOT_ALLOWED');
});

test('FakeAdapter scripts responses and records calls', async () => {
  const fake = new FakeAdapter({
    id: 'node',
    scripted: {
      detect: { version: '20' },
      install: applyResult({ changed: true, status: 'INSTALLED', message: 'fake-installed' }),
    },
  });
  const detected = await fake.detect();
  assert.equal(detected.version, '20');
  assert.equal(detected.status, 'INSTALLED');
  const installed = await fake.install('22');
  assert.equal(installed.message, 'fake-installed');
  assert.deepEqual(fake.calls, [['detect'], ['install', '22']]);
});

test('FakeAdapter respects refuse list', () => {
  const fake = new FakeAdapter({ id: 'git' });
  assert.throws(() => fake._check('uninstall-managed'), (err) => err.code === 'ADAPTER_ACTION_REFUSED');
});

test('planOne combines adapter.detect() with diff rules', async () => {
  const fake = new FakeAdapter({ id: 'python', scripted: { detect: { version: '3.11' } } });
  const step = await planOne(fake, '3.12');
  assert.deepEqual(step, { resource: 'python', action: 'UPDATE', version: '3.12', previous: '3.11' });
});

test('okResult and applyResult have the right defaults', () => {
  assert.equal(okResult('OK').changed, false);
  assert.equal(applyResult({ changed: true, status: 'X' }).success, true);
});

test('BaseAdapter.uninstall is refused by default (spec §18 safety)', async () => {
  const a = new BaseAdapter({ id: 'git' });
  await assert.rejects(
    () => a.uninstall(),
    (err) => err instanceof AdapterError && err.code === 'ADAPTER_ACTION_REFUSED'
  );
});
