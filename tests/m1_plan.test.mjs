import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  ManifestError,
  ObservedState,
  loadManifest,
  validateManifest,
  planFromManifest,
  planFromYaml,
  run,
} from '../src/workbench.mjs';
import { ObservedState as CoreObservedState } from '../core/state.mjs';

// Sanity check: M1's re-exported ObservedState is the same class as the
// canonical core/state.mjs one. Keeps the back-compat contract honest.
assert.equal(ObservedState, CoreObservedState, 'ObservedState must be re-exported from core/state.mjs');

const validManifest = {
  version: '1',
  workspace: { id: 'MyWorkspace', name: 'My Agent Workspace' },
  environment: {
    node: { version: '22' },
    python: { version: '3.12' },
    uv: { version: 'latest' },
  },
};

test('planFromManifest reports update, skip, and install for example workspace', () => {
  const plan = planFromManifest(validManifest, new ObservedState({ node: '20', python: '3.12' }));
  assert.deepEqual(plan.steps, [
    { action: 'UPDATE', resource: 'node', version: '22', previous: '20' },
    { action: 'SKIP', resource: 'python', version: '3.12', previous: null },
    { action: 'INSTALL', resource: 'uv', version: 'latest', previous: null },
  ]);
  assert.equal(plan.workspace, 'MyWorkspace');
});

test('planFromManifest marks matching versions as SKIP', () => {
  const plan = planFromManifest(validManifest, new ObservedState({ node: '22', python: '3.12', uv: 'latest' }));
  assert.deepEqual(plan.steps.map((s) => s.action), ['SKIP', 'SKIP', 'SKIP']);
});

test('planFromManifest marks missing tools as INSTALL with previous=null', () => {
  const plan = planFromManifest(validManifest, new ObservedState({}));
  assert.deepEqual(plan.steps.map((s) => s.action), ['INSTALL', 'INSTALL', 'INSTALL']);
  assert.ok(plan.steps.every((s) => s.previous === null));
});

test('planFromManifest marks downgrades as UPDATE', () => {
  const plan = planFromManifest(validManifest, new ObservedState({ node: '24', python: '3.13' }));
  assert.equal(plan.steps[0].action, 'UPDATE');
  assert.equal(plan.steps[0].previous, '24');
  assert.equal(plan.steps[0].version, '22');
});

test('validateManifest rejects unknown version', () => {
  assert.throws(
    () => validateManifest({ ...validManifest, version: '2' }),
    (err) => err instanceof ManifestError && err.code === 'MANIFEST_VERSION_UNSUPPORTED' && err.field === 'version'
  );
});

test('validateManifest rejects missing workspace.id', () => {
  assert.throws(
    () => validateManifest({ ...validManifest, workspace: {} }),
    (err) => err instanceof ManifestError && err.field === 'workspace.id'
  );
});

test('validateManifest rejects missing environment version', () => {
  assert.throws(
    () =>
      validateManifest({
        ...validManifest,
        environment: { node: {} },
      }),
    (err) => err instanceof ManifestError && err.field === 'environment.node.version'
  );
});

test('validateManifest rejects empty environment', () => {
  assert.throws(
    () => validateManifest({ ...validManifest, environment: {} }),
    (err) => err instanceof ManifestError && err.field === 'environment'
  );
});

test('validateManifest rejects non-object manifest', () => {
  assert.throws(
    () => validateManifest('nope'),
    (err) => err instanceof ManifestError && err.code === 'MANIFEST_SHAPE_ERROR'
  );
});

test('validateManifest rejects workspace.id with shell-meta characters', () => {
  assert.throws(
    () => validateManifest({ ...validManifest, workspace: { id: '../etc/passwd' } }),
    (err) => err instanceof ManifestError && err.field === 'workspace.id' && err.code === 'MANIFEST_FIELD_INVALID'
  );
});

test('validateManifest rejects environment.version with shell-meta characters', () => {
  assert.throws(
    () => validateManifest({ ...validManifest, environment: { node: { version: '22; rm -rf /' } } }),
    (err) => err instanceof ManifestError && err.field === 'environment.node.version' && err.code === 'MANIFEST_FIELD_INVALID'
  );
});

test('validateManifest rejects unknown environment resources', () => {
  assert.throws(
    () => validateManifest({ ...validManifest, environment: { docker: { version: '24' } } }),
    (err) => err instanceof ManifestError && err.code === 'MANIFEST_UNKNOWN_RESOURCE'
  );
});

test('validateManifest rejects malformed agents entries at the manifest boundary', () => {
  assert.throws(
    () => validateManifest({ ...validManifest, agents: [{ id: '../escape' }] }),
    (err) => err instanceof ManifestError && err.field.startsWith('agents[')
  );
});

test('validateManifest rejects malformed mcp entries at the manifest boundary', () => {
  assert.throws(
    () => validateManifest({ ...validManifest, mcp: [{ id: 'fs', transport: 'weird' }] }),
    (err) => err instanceof ManifestError && err.field.startsWith('mcp[')
  );
});

test('validateManifest rejects malformed packages entries at the manifest boundary', () => {
  assert.throws(
    () => validateManifest({ ...validManifest, packages: [{ id: 'x', type: 'unknown' }] }),
    (err) => err instanceof ManifestError && err.field.startsWith('packages[')
  );
});

test('validateManifest rejects non-array projects at the manifest boundary', () => {
  assert.throws(
    () => validateManifest({ ...validManifest, projects: 'oops' }),
    (err) => err instanceof ManifestError && err.code === 'MANIFEST_FIELD_INVALID' && err.field === 'projects'
  );
});

test('loadManifest parses JSON and rejects malformed input', () => {
  const tmp = path.join(os.tmpdir(), `manifest-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{ this is not json');
  try {
    assert.throws(() => loadManifest(tmp), (err) => err instanceof ManifestError && err.code === 'MANIFEST_PARSE_ERROR');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('loadManifest rejects non-object root (e.g. JSON array)', () => {
  const tmp = path.join(os.tmpdir(), `manifest-array-${Date.now()}.json`);
  fs.writeFileSync(tmp, '[]');
  try {
    assert.throws(() => loadManifest(tmp), (err) => err instanceof ManifestError && err.code === 'MANIFEST_SHAPE_ERROR');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('planFromYaml still works for inline JSON text (back-compat alias)', () => {
  const plan = planFromYaml(JSON.stringify(validManifest), new ObservedState({}));
  assert.equal(plan.workspace, 'MyWorkspace');
  assert.equal(plan.steps.length, 3);
});

// ----- CLI surface tests -----------------------------------------------------

test('CLI plan prints the expected preview against the JSON fixture', async () => {
  // Set the observed versions deterministically for this CLI run. We restore
  // prior values in finally to keep other tests independent.
  const saved = {};
  for (const [k, v] of [
    ['WORKBENCH_NODE_VERSION', '20'],
    ['WORKBENCH_PYTHON_VERSION', '3.12'],
    ['WORKBENCH_UV_VERSION', undefined],
  ]) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const stdout = [];
    const code = await run(['plan', '--manifest', 'fixtures/example-workspace.json'], {
      write: (chunk) => stdout.push(chunk),
    });
    assert.equal(code, 0);
    const out = stdout.join('');
    assert.match(out, /Workspace: MyWorkspace/);
    assert.match(out, /1 UPDATE node 20 → 22/);
    assert.match(out, /2 SKIP python 3.12/);
    assert.match(out, /3 INSTALL uv latest/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('CLI plan prints pure INSTALL when no observed versions are injected', async () => {
  // Default observed state is empty unless env vars override. We strip the
  // known env vars defensively for this test process so the assertion is
  // deterministic regardless of how`node --test` was invoked.
  for (const k of ['WORKBENCH_NODE_VERSION', 'WORKBENCH_PYTHON_VERSION', 'WORKBENCH_UV_VERSION']) {
    delete process.env[k];
  }
  const stdout = [];
  const code = await run(['plan', '--manifest', 'fixtures/example-workspace.json'], {
    write: (chunk) => stdout.push(chunk),
  });
  assert.equal(code, 0);
  const out = stdout.join('');
  assert.match(out, /1 INSTALL node 22/);
  assert.match(out, /3 INSTALL uv latest/);
});

test('CLI plan rejects YAML manifest with a clear message and non-zero exit', async () => {
  const code = await run(['plan', '--manifest', 'fixtures/example-workspace.yaml'], { write: () => {} });
  assert.notEqual(code, 0);
});

test('CLI handles missing manifest with a clean ManifestError message (no stack trace)', async () => {
  // Regression: resolveManifestPath used to throw before the try/catch in
  // runPlan, leaking the Error stack through the entrypoint's catch-all.
  const stderr = [];
  const code = await run(['plan', '--manifest', 'definitely-not-here.json'], { write: () => {} }, { write: (chunk) => stderr.push(chunk) });
  assert.equal(code, 1);
  const out = stderr.join('');
  assert.match(out, /workbench: manifest file not found/);
  assert.match(out, /field: <path>/);
  assert.doesNotMatch(out, /unexpected error/);
  assert.doesNotMatch(out, /at .+\.mjs:\d+:\d+/);
});

test('CLI handles missing manifest default lookup (no --manifest) without stack trace', async () => {
  // When run from a directory without workspace.json/yaml, the lookup path
  // also throws — make sure the message reaches stderr cleanly.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-no-manifest-'));
  try {
    const stderr = [];
    const code = await run(['plan'], { write: () => {} }, { write: (chunk) => stderr.push(chunk) }, tmp);
    assert.equal(code, 1);
    const out = stderr.join('');
    assert.match(out, /workbench: no manifest found/);
    assert.doesNotMatch(out, /unexpected error/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('run with --help prints the usage banner and exits 0', async () => {
  const stdout = [];
  const code = await run(['--help'], { write: (chunk) => stdout.push(chunk) });
  assert.equal(code, 0);
  assert.match(stdout.join(''), /workbench plan \[--manifest PATH\]/);
});

test('run rejects unknown commands with exit code 2', async () => {
  const stderr = [];
  const code = await run(['frobnicate'], { write: () => {} }, { write: (chunk) => stderr.push(chunk) });
  assert.equal(code, 2);
  assert.match(stderr.join(''), /unknown command/);
});

test('resolveManifestPath finds workspace.json in cwd when --manifest is omitted', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-default-'));
  fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify({
    version: '1',
    workspace: { id: 'Tmp' },
    environment: { node: { version: '22' } },
  }));
  try {
    const stdout = [];
    const code = await run(['plan'], { write: (chunk) => stdout.push(chunk) }, { write: () => {} }, tmp);
    assert.equal(code, 0);
    assert.match(stdout.join(''), /Workspace: Tmp/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
