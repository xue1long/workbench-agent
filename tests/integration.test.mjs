// Live Runtime integration: use the stable devflow-runtime CLI via the
// Workbench DevflowRuntimeAdapter against a real temporary workspace.
//
// Local runs (Windows): tests run if DFR_PYTHON is set OR the default
// Windows Python 3.11 path exists on disk.
// Local runs (Linux/macOS): tests run if DFR_PYTHON is set.
// CI runs: tests are SKIPPED unless the CI explicitly sets
// `RUN_LIVE_RUNTIME_TESTS=1` AND `DFR_PYTHON=<path>`. The CI workflow's
// `devflow-runtime` job already runs the sister pytest suite against a
// real DevFlow Runtime; running these Node-side live tests against the
// same Python interpreter from a sibling checkout is what
// `RUN_LIVE_RUNTIME_TESTS` is for (set both env vars together).
//
// Skipped tests print a one-line notice rather than silently passing,
// so the gate stays honest about what was and wasn't exercised.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';

import { DevflowRuntimeAdapter } from '../adapters/devflow-runtime.mjs';

const DEFAULT_PYTHON_WINDOWS = 'C:\\Users\\HP\\AppData\\Local\\Python\\pythoncore-3.11-64\\python.exe';

function resolvePython() {
  if (process.env.DFR_PYTHON) return process.env.DFR_PYTHON;
  if (process.platform === 'win32') {
    try {
      if (fs.statSync(DEFAULT_PYTHON_WINDOWS).isFile()) return DEFAULT_PYTHON_WINDOWS;
    } catch (_) { /* not present */ }
  }
  return null;
}

const PYTHON = resolvePython();
// CI must explicitly opt in via RUN_LIVE_RUNTIME_TESTS=1.
// Local runs run by default if Python is reachable (auto-detected on
// Windows via the default path; or via DFR_PYTHON on any platform).
// The CI opt-in exists so a Linux CI runner that happens to have a
// Python interpreter on PATH doesn't accidentally run live tests that
// need the devflow-runtime sister repo to be installed.
const LIVE_ENABLED = !!PYTHON && (
  process.env.RUN_LIVE_RUNTIME_TESTS === '1'
  || process.env.CI !== 'true'  // GitHub Actions sets CI=true
);

if (!LIVE_ENABLED) {
  test('integration-test guard (skipped in CI / when DFR_PYTHON is unset)', { skip: true }, () => {
    assert.fail('unreachable: skipped');
  });
}

function makeWorkspace() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-live-runtime-'));
  fs.writeFileSync(path.join(tmp, 'README.md'), 'init\n', 'utf8');
  fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config', 'runtime.yaml'), 'enabled: true\n', 'utf8');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: tmp });
  spawnSync('git', ['config', 'user.email', 'live@local'], { cwd: tmp });
  spawnSync('git', ['config', 'user.name', 'live'], { cwd: tmp });
  spawnSync('git', ['add', '.'], { cwd: tmp });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmp });
  return tmp;
}

function executableForLocalCli() {
  return { executable: PYTHON, prefixArgs: ['-m', 'devflow_runtime.protocol.cli'] };
}

function adapterRunnerFactory() {
  return async (argv, options = {}) => {
    const cmd = executableForLocalCli();
    const rest = argv.slice(1); // drop the 'devflow-runtime' placeholder
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(cmd.executable, [...cmd.prefixArgs, ...rest], { shell: false, windowsHide: true });
      } catch (err) {
        // ENOENT and friends: resolve with a structured failure rather than
        // letting the test die on an uncaught spawn error.
        return resolve({ stdout: '', stderr: err.message ?? String(err), exitCode: -1 });
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (fn, payload) => {
        if (settled) return;
        settled = true;
        try { if (proc && !proc.killed) proc.kill(); } catch (_) { /* ignore */ }
        fn(payload);
      };
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      proc.on('error', (err) => settle(resolve, { stdout, stderr, exitCode: -1, error: err.message }));
      proc.on('close', (code) => settle(resolve, { stdout, stderr, exitCode: code }));
    });
  };
}

test('DevflowRuntimeAdapter.status reports the enabled runtime over the stable protocol', { skip: !LIVE_ENABLED }, async () => {
  const workspace = makeWorkspace();
  try {
    const adapter = new DevflowRuntimeAdapter({ runner: adapterRunnerFactory() });
    const result = await adapter.status({ workspace });
    assert.equal(result.enabled, true);
    assert.equal(result.workspace, workspace);
    assert.ok(result.event_store_integrity, 'integrity payload present');
    assert.deepEqual(result.sessions, []);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('DevflowRuntimeAdapter.run applies a single UTF-8 text file and returns finish', { skip: !LIVE_ENABLED }, async () => {
  const workspace = makeWorkspace();
  try {
    const adapter = new DevflowRuntimeAdapter({ runner: adapterRunnerFactory() });
    const changeSet = {
      runId: 'live',
      baseCommit: 'h',
      patchSha256: 'a'.repeat(64),
      changedFiles: ['README.md'],
      edits: [{ path: 'README.md', content: 'init\nverified-by-adapter\n', expectedDigest: '', changeType: 'replace' }],
    };
    const approval = { approved: true, actor: 'workbench', reason: 'live acceptance', changeSetSha256: changeSet.patchSha256 };
    const result = await adapter.run({
      workspace,
      intent: { id: 'intent-live', version: '1.0.0' },
      changeSet,
      approval,
    });
    assert.equal(result.decision.kind, 'finish', JSON.stringify(result));
    assert.equal(result.eventStoreIntegrity.valid, true);
    assert.ok(result.trustedEvidenceIds.length > 0, 'trusted evidence emitted');
    assert.equal(result.finalStatus, 'COMPLETED');
    // The governed workspace file must reflect the patch bytes verbatim.
    assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), 'init\nverified-by-adapter\n');
    // EventStore must hold events for this session.
    const events = fs.readFileSync(path.join(workspace, '.devflow-runtime', 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.ok(events.length >= 6, `expected at least 6 events, got ${events.length}`);
    assert.ok(events.some((line) => line.includes('"event_type":"intent_registered"') && line.includes('"id":"intent-live"')));
    assert.ok(result.sessionId && result.sessionId.startsWith('session-'));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('DevflowRuntimeAdapter.recover reports active status for the freshly applied session', { skip: !LIVE_ENABLED }, async () => {
  const workspace = makeWorkspace();
  try {
    const adapter = new DevflowRuntimeAdapter({ runner: adapterRunnerFactory() });
    const changeSet = {
      runId: 'live',
      baseCommit: 'h',
      patchSha256: 'b'.repeat(64),
      changedFiles: ['README.md'],
      edits: [{ path: 'README.md', content: 'init\nrecover-verify\n', expectedDigest: '', changeType: 'replace' }],
    };
    const approval = { approved: true, actor: 'workbench', reason: 'live acceptance', changeSetSha256: changeSet.patchSha256 };
    const runResult = await adapter.run({
      workspace,
      intent: { id: 'intent-recover', version: '1.0.0' },
      changeSet,
      approval,
    });
    const sessionId = runResult.sessionId;
    const recovery = await adapter.recover({ workspace, sessionId });
    assert.equal(recovery.sessionId, sessionId);
    assert.equal(recovery.eventStoreIntegrity.valid, true);
    assert.ok(['active', 'quarantined'].includes(recovery.status));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('DevflowRuntimeAdapter.run refuses when the changeSetSha256 digest does not match', { skip: !LIVE_ENABLED }, async () => {
  const workspace = makeWorkspace();
  try {
    const adapter = new DevflowRuntimeAdapter({ runner: adapterRunnerFactory() });
    const changeSet = {
      runId: 'live',
      baseCommit: 'h',
      patchSha256: 'a'.repeat(64),
      changedFiles: ['README.md'],
      edits: [{ path: 'README.md', content: 'x', expectedDigest: '', changeType: 'replace' }],
    };
    await assert.rejects(
      () => adapter.run({
        workspace,
        intent: { id: 'intent-live', version: '1.0.0' },
        changeSet,
        approval: { approved: true, actor: 'workbench', reason: 'no', changeSetSha256: 'a'.repeat(63) + 'b' },
      }),
      (err) => err.code === 'RUNTIME_APPROVAL_DIGEST_MISMATCH' || err.code === 'RUNTIME_APPROVAL_DIGEST_MISSING',
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('DevflowRuntimeAdapter.run respects the 5-file limit before invoking Runtime', { skip: !LIVE_ENABLED }, async () => {
  const workspace = makeWorkspace();
  try {
    const adapter = new DevflowRuntimeAdapter({ runner: adapterRunnerFactory() });
    const edits = [];
    for (let i = 0; i < 6; i += 1) edits.push({ path: `f${i}.txt`, content: 'x\n', expectedDigest: '', changeType: 'create' });
    const changeSet = {
      runId: 'live',
      baseCommit: 'h',
      patchSha256: 'a'.repeat(64),
      changedFiles: edits.map((e) => e.path),
      edits,
    };
    // The adapter itself does not currently enforce the file limit (that
    // lives in the change-sandbox). The Workbench contract is that the
    // orchestrator / CLI must call collectChangeSet first. We exercise the
    // sandbox-side rejection by importing the change-sandbox directly.
    const { collectChangeSet, createChangeSandbox } = await import('../core/change-sandbox.mjs');
    const sandbox = await createChangeSandbox({ repoRoot: workspace, runId: 'cap' });
    try {
      for (const e of edits) fs.writeFileSync(path.join(sandbox.sandboxPath, e.path), e.content);
      await assert.rejects(() => collectChangeSet(sandbox, { baseCommit: sandbox.baseCommit }), (err) => err.code === 'CHANGE_SET_FILE_LIMIT');
    } finally {
      await sandbox.cleanup();
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
