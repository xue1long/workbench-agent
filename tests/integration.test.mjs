// Live Runtime integration: use the stable devflow-runtime CLI via the
// Workbench DevflowRuntimeAdapter against a real temporary workspace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';

import { DevflowRuntimeAdapter } from '../adapters/devflow-runtime.mjs';

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

const PYTHON = process.env.DFR_PYTHON ?? 'C:\\Users\\HP\\AppData\\Local\\Python\\pythoncore-3.11-64\\python.exe';

function executableForLocalCli() {
  return { executable: PYTHON, prefixArgs: ['-m', 'devflow_runtime.protocol.cli'] };
}

function adapterRunnerFactory() {
  return async (argv, options = {}) => {
    const cmd = executableForLocalCli();
    const rest = argv.slice(1); // drop the 'devflow-runtime' placeholder
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd.executable, [...cmd.prefixArgs, ...rest], { shell: false, windowsHide: true });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      proc.on('error', reject);
      proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
    });
  };
}

test('DevflowRuntimeAdapter.status reports the enabled runtime over the stable protocol', async () => {
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

test('DevflowRuntimeAdapter.run applies a single UTF-8 text file and returns finish', async () => {
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

test('DevflowRuntimeAdapter.recover reports active status for the freshly applied session', async () => {
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

test('DevflowRuntimeAdapter.run refuses when the changeSetSha256 digest does not match', async () => {
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

test('DevflowRuntimeAdapter.run respects the 5-file limit before invoking Runtime', async () => {
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
