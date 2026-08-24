import test from 'node:test';
import assert from 'node:assert/strict';

import { applyPlan, isNoChanges } from '../core/apply.mjs';
import { FakeAdapter, AdapterError, applyResult } from '../core/adapters.mjs';

function planFor(steps) {
  return { workspace: 'MyWorkspace', steps };
}

test('dry-run does not call adapter.install/update and reports PREVIEW for every step', async () => {
  const fake = new FakeAdapter({
    id: 'node',
    scripted: { detect: { version: '20' } },
  });
  const plan = planFor([
    { resource: 'node', action: 'UPDATE', version: '22', previous: '20' },
  ]);
  const report = await applyPlan(plan, new Map([['node', fake]]));
  assert.equal(report.dryRun, true);
  assert.equal(report.changed, false);
  assert.equal(report.steps[0].status, 'PREVIEW');
  assert.deepEqual(fake.calls, [], 'install/update must not be called in dry-run');
});

test('--apply routes UPDATE through adapter.update and tracks changed=true', async () => {
  const fake = new FakeAdapter({
    id: 'python',
    scripted: { detect: { version: '3.11' } },
  });
  const plan = planFor([
    { resource: 'python', action: 'UPDATE', version: '3.12', previous: '3.11' },
  ]);
  const report = await applyPlan(plan, new Map([['python', fake]]), { apply: true });
  assert.equal(report.dryRun, false);
  assert.equal(report.changed, true);
  assert.equal(report.steps[0].status, 'APPLIED');
  assert.deepEqual(fake.calls, [['update', '3.12']]);
});

test('SKIP is a no-op even with apply=true', async () => {
  const fake = new FakeAdapter({
    id: 'node',
    scripted: { detect: { version: '22' } },
  });
  const plan = planFor([
    { resource: 'node', action: 'SKIP', version: '22', previous: null },
  ]);
  const report = await applyPlan(plan, new Map([['node', fake]]), { apply: true });
  assert.equal(report.steps[0].status, 'NO_CHANGE');
  assert.deepEqual(fake.calls, [], 'SKIP must not invoke the adapter');
});

test('Second apply after a successful apply is a no-op when the plan is rebuilt (idempotency)', async () => {
  const fake = new FakeAdapter({
    id: 'node',
    scripted: { detect: { version: null }, install: applyResult({ changed: true, status: 'INSTALLED' }) },
  });
  const installPlan = planFor([
    { resource: 'node', action: 'INSTALL', version: '22', previous: null },
  ]);
  const first = await applyPlan(installPlan, new Map([['node', fake]]), { apply: true });
  assert.equal(first.summary.applied, 1);

  // After the first apply, the host reports the tool as installed. Rebuilding
  // the plan (as `workbench apply` does in production) yields SKIP for the
  // same resource — the second apply is a true no-op.
  fake.scripted.detect = { version: '22' };
  const secondPlan = planFor([
    { resource: 'node', action: 'SKIP', version: '22', previous: null },
  ]);
  const second = await applyPlan(secondPlan, new Map([['node', fake]]), { apply: true });
  assert.equal(second.summary.applied, 0);
  assert.equal(second.summary.noChange, 1);
  assert.ok(isNoChanges(second));
  assert.equal(fake.calls.length, 1, 'install must not run again after SKIP plan');
});

test('Failure short-circuits downstream steps', async () => {
  const nodeFake = new FakeAdapter({
    id: 'node',
    scripted: { detect: { version: '20' }, update: { success: false, changed: false, status: 'ERROR', message: 'boom' } },
  });
  const pythonFake = new FakeAdapter({
    id: 'python',
    scripted: { detect: { version: null }, install: applyResult({ changed: true, status: 'INSTALLED' }) },
  });
  const plan = planFor([
    { resource: 'node', action: 'UPDATE', version: '22', previous: '20' },
    { resource: 'python', action: 'INSTALL', version: '3.12', previous: null },
  ]);
  const report = await applyPlan(plan, new Map([['node', nodeFake], ['python', pythonFake]]), { apply: true });
  assert.equal(report.steps[0].status, 'FAILED');
  assert.equal(report.steps[1].status, 'BLOCKED');
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.blocked, 1);
  assert.deepEqual(pythonFake.calls, [], 'python.install must not run after node failed');
  assert.equal(report.error.code, 'APPLY_ADAPTER_FAILED');
});

test('AdapterError is wrapped as ApplyError with the right code', async () => {
  const fake = new FakeAdapter({
    id: 'node',
    scripted: { detect: { version: null }, install: () => { throw new AdapterError('refused', { code: 'ADAPTER_ACTION_REFUSED', resource: 'node', action: 'install' }); } },
  });
  const plan = planFor([{ resource: 'node', action: 'INSTALL', version: '22', previous: null }]);
  const report = await applyPlan(plan, new Map([['node', fake]]), { apply: true });
  assert.equal(report.steps[0].status, 'FAILED');
  assert.equal(report.steps[0].error.code, 'ADAPTER_ACTION_REFUSED');
  assert.equal(report.error.code, 'ADAPTER_ACTION_REFUSED');
});

test('Missing adapter fails the step with APPLY_NO_ADAPTER', async () => {
  const plan = planFor([{ resource: 'ruby', action: 'INSTALL', version: '3.4', previous: null }]);
  const report = await applyPlan(plan, new Map(), { apply: true });
  assert.equal(report.steps[0].status, 'FAILED');
  assert.equal(report.steps[0].error.code, 'APPLY_NO_ADAPTER');
  assert.equal(report.error.code, 'APPLY_NO_ADAPTER');
});

test('stopOnFailure=false lets remaining steps run after a failure', async () => {
  const nodeFake = new FakeAdapter({
    id: 'node',
    scripted: { detect: { version: '20' }, update: { success: false, changed: false, status: 'ERROR', message: 'nope' } },
  });
  const pythonFake = new FakeAdapter({
    id: 'python',
    scripted: { detect: { version: null }, install: applyResult({ changed: true, status: 'INSTALLED' }) },
  });
  const plan = planFor([
    { resource: 'node', action: 'UPDATE', version: '22', previous: '20' },
    { resource: 'python', action: 'INSTALL', version: '3.12', previous: null },
  ]);
  const report = await applyPlan(plan, new Map([['node', nodeFake], ['python', pythonFake]]), { apply: true, stopOnFailure: false });
  assert.equal(report.steps[0].status, 'FAILED');
  assert.equal(report.steps[1].status, 'APPLIED');
  assert.equal(report.summary.applied, 1);
  assert.equal(report.summary.failed, 1);
});

test('Dry-run reports appliedState with PREVIEW status entries', async () => {
  const fake = new FakeAdapter({ id: 'uv', scripted: { detect: { version: null } } });
  const plan = planFor([{ resource: 'uv', action: 'INSTALL', version: 'latest', previous: null }]);
  const report = await applyPlan(plan, new Map([['uv', fake]]));
  assert.equal(report.appliedState.workspaceId, 'MyWorkspace');
  assert.equal(report.appliedState.steps[0].status, 'SKIPPED');
});

test('onStep callback receives every step record', async () => {
  const fake = new FakeAdapter({ id: 'node', scripted: { detect: { version: '22' } } });
  const seen = [];
  const plan = planFor([{ resource: 'node', action: 'SKIP', version: '22', previous: null }]);
  await applyPlan(plan, new Map([['node', fake]]), { onStep: (rec) => seen.push(rec.status) });
  assert.deepEqual(seen, ['PREVIEW']);
});

test('AppliedStep preserves details and error from the engine record', async () => {
  const fake = new FakeAdapter({
    id: 'node',
    scripted: { detect: { version: '20' }, update: { success: false, changed: false, status: 'ERROR', message: 'kaboom', details: { code: 42 } } },
  });
  const plan = planFor([{ resource: 'node', action: 'UPDATE', version: '22', previous: '20' }]);
  const report = await applyPlan(plan, new Map([['node', fake]]), { apply: true });
  const step = report.appliedState.steps[0];
  assert.equal(step.status, 'FAILED');
  assert.deepEqual(step.details, { code: 42 });
  assert.deepEqual(step.error, { code: 'APPLY_ADAPTER_FAILED' });
});

test('applyPlan accepts an empty plan and reports no changes', async () => {
  const report = await applyPlan({ workspace: 'X', steps: [] }, new Map(), { apply: true });
  assert.equal(report.summary.total, 0);
  assert.equal(report.summary.applied, 0);
  assert.equal(report.changed, false);
  assert.deepEqual(report.steps, []);
  assert.deepEqual(report.appliedState.steps, []);
});

test('applyPlan rejects a plan whose steps field is not an array', async () => {
  await assert.rejects(
    () => applyPlan({ workspace: 'X', steps: 'oops' }, new Map()),
    (err) => err.name === 'ApplyError' && err.code === 'APPLY_BAD_PLAN'
  );
});

test('applyPlan catches a synchronous throw from the adapter', async () => {
  const fake = new FakeAdapter({
    id: 'node',
    scripted: { detect: { version: '20' }, update: () => { throw new Error('sync boom'); } },
  });
  const plan = planFor([{ resource: 'node', action: 'UPDATE', version: '22', previous: '20' }]);
  const report = await applyPlan(plan, new Map([['node', fake]]), { apply: true });
  assert.equal(report.steps[0].status, 'FAILED');
  assert.equal(report.steps[0].error.code, 'APPLY_EXCEPTION');
});

test('applyPlan treats an adapter returning undefined as FAILED (not silent APPLIED)', async () => {
  // Use a base adapter with overridden install returning undefined to bypass
  // the FakeAdapter fallback that would synthesize a fake success.
  const base = new (await import('../core/adapters.mjs')).BaseAdapter({
    id: 'node',
    allowedActions: new Set(['install', 'detect']),
  });
  base.install = async () => undefined;
  const plan = planFor([{ resource: 'node', action: 'INSTALL', version: '22', previous: null }]);
  const report = await applyPlan(plan, new Map([['node', base]]), { apply: true });
  assert.equal(report.steps[0].status, 'FAILED');
});
