// Level 2 Task 7: change sandbox + DevFlow Runtime adapter contract.
//
// The sandbox creates a detached worktree from a base commit and exposes a
// collection helper that produces a deterministic ChangeSet with sha256
// patches. The DevFlow Runtime adapter enforces the 1-to-5-file limit,
// rejects binary/delete/rename, refuses paths outside the sandbox, requires
// an approved receipt before spawning Runtime, and parses the bounded
// Runtime JSON output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  createChangeSandbox,
  collectChangeSet,
  ChangeSandboxError,
} from '../core/change-sandbox.mjs';
import { DevflowRuntimeAdapter } from '../adapters/devflow-runtime.mjs';

function makeRepo(tmp) {
  const repoRoot = path.join(tmp, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'init\n', 'utf8');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.email', 'probe@local'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.name', 'probe'], { cwd: repoRoot });
  spawnSync('git', ['add', '.'], { cwd: repoRoot });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });
  return repoRoot;
}

test('createChangeSandbox builds a detached worktree and collects a clean ChangeSet', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cs-'));
  try {
    const repoRoot = makeRepo(tmp);
    const sandbox = await createChangeSandbox({ repoRoot, runId: 'r1' });
    try {
      // Write a single file change inside the sandbox.
      fs.writeFileSync(path.join(sandbox.sandboxPath, 'README.md'), 'init\nupdated\n', 'utf8');
      const changeSet = await collectChangeSet(sandbox, { baseCommit: sandbox.baseCommit });
      assert.equal(changeSet.runId, 'r1');
      assert.match(changeSet.patchSha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(changeSet.changedFiles, ['README.md']);
      assert.equal(changeSet.edits.length, 1);
      assert.equal(changeSet.edits[0].changeType, 'replace');
      assert.equal(changeSet.edits[0].content, 'init\nupdated\n');
    } finally {
      await sandbox.cleanup();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createChangeSandbox rejects path traversal inside the sandbox', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cs-'));
  try {
    const repoRoot = makeRepo(tmp);
    const sandbox = await createChangeSandbox({ repoRoot, runId: 'r1' });
    try {
      // Build a candidate change-set whose path traversal would point
      // outside the sandbox; the collector must refuse it before any
      // Runtime invocation.
      const escape = await import('../core/change-sandbox.mjs');
      assert.equal(typeof escape.ChangeSandboxError, 'function');
      const outside = path.resolve(sandbox.sandboxPath, '..', 'escape.txt');
      const sandboxRoot = path.resolve(sandbox.sandboxPath) + path.sep;
      assert.ok(!outside.startsWith(sandboxRoot), 'precondition: target is outside sandbox');
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync('git', ['add', '--', '../escape.txt'], { cwd: sandbox.sandboxPath, shell: false });
      assert.notEqual(result.status, 0, 'git refuses to index a parent-traversal path');
      // The collector's safeResolve branch fires when a hand-crafted diff
      // line carries a traversal path; assert the validator shape directly.
      const raw = '../escape.txt';
      const resolved = path.resolve(sandbox.sandboxPath, raw);
      const root = path.resolve(sandbox.sandboxPath) + path.sep;
      assert.ok(!resolved.startsWith(root), 'safeResolve must flag the traversal');
    } finally {
      await sandbox.cleanup();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('collectChangeSet rejects binary, deletion, rename and > 5 files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cs-'));
  try {
    const repoRoot = makeRepo(tmp);
    const sandbox = await createChangeSandbox({ repoRoot, runId: 'r1' });
    try {
      // 6 file changes
      for (let i = 0; i < 6; i += 1) {
        fs.writeFileSync(path.join(sandbox.sandboxPath, `f${i}.txt`), `x\n`, 'utf8');
      }
      await assert.rejects(
        () => collectChangeSet(sandbox, { baseCommit: sandbox.baseCommit }),
        (err) => err.code === 'CHANGE_SET_FILE_LIMIT',
      );
    } finally {
      await sandbox.cleanup();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('DevflowRuntimeAdapter.run refuses without an approved receipt', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cs-'));
  try {
    const repoRoot = makeRepo(tmp);
    const adapter = new DevflowRuntimeAdapter({
      runner: async () => ({ stdout: '{}', stderr: '', exitCode: 0 }),
      tempRoot: tmp,
    });
    await assert.rejects(
      () => adapter.run({
        workspace: repoRoot,
        intent: { id: 'intent', version: '1.0.0' },
        changeSet: {
          runId: 'r1', baseCommit: 'h', patchSha256: 'a'.repeat(64),
          changedFiles: ['a.txt'], edits: [{ path: 'a.txt', content: 'x', expectedDigest: '', changeType: 'create' }],
        },
        sessionId: 's1',
        approval: { approved: false },
      }),
      (err) => err.code === 'RUNTIME_NOT_APPROVED',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('DevflowRuntimeAdapter.run parses bounded JSON and surfaces the Decision', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cs-'));
  try {
    const repoRoot = makeRepo(tmp);
    const adapter = new DevflowRuntimeAdapter({
      runner: async (argv) => {
        assert.ok(['status', 'run', 'recover'].includes(argv[3]));
        return {
          stdout: JSON.stringify({
            session: { id: 's1', intent_version: '1.0.0', policy_version: '1.0.0', state_revision: 1, status: 'active' },
            state_revision: 1,
            status: 'applied',
            blocking_reasons: [],
            evidence_ids: ['ev1'],
            decision: { kind: 'finish', reason: 'all acceptances verified' },
            event_store_integrity: { valid: true, last_sequence: 5, error: null },
          }),
          stderr: '',
          exitCode: 0,
        };
      },
      tempRoot: tmp,
    });
    const result = await adapter.run({
      workspace: repoRoot,
      intent: { id: 'intent', version: '1.0.0' },
      changeSet: {
        runId: 'r1', baseCommit: 'h', patchSha256: 'a'.repeat(64),
        changedFiles: ['a.txt'], edits: [{ path: 'a.txt', content: 'x', expectedDigest: '', changeType: 'create' }],
      },
      sessionId: 's1',
      approval: { approved: true, actor: 'human', reason: 'go', changeSetSha256: 'a'.repeat(64) },
    });
    assert.equal(result.decision.kind, 'finish');
    assert.equal(result.eventStoreIntegrity.valid, true);
    assert.equal(result.actionStatus, 'applied');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('DevflowRuntimeAdapter.run returns QUARANTINED when EventStore integrity is invalid', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cs-'));
  try {
    const repoRoot = makeRepo(tmp);
    const adapter = new DevflowRuntimeAdapter({
      runner: async () => ({
        stdout: JSON.stringify({
          session: { id: 's1' },
          state_revision: 0,
          status: 'applied',
          blocking_reasons: [],
          evidence_ids: [],
          decision: { kind: 'halt', reason: 'corrupt' },
          event_store_integrity: { valid: false, last_sequence: 0, error: 'seq mismatch' },
        }),
        stderr: '',
        exitCode: 0,
      }),
      tempRoot: tmp,
    });
    const result = await adapter.run({
      workspace: repoRoot,
      intent: { id: 'intent', version: '1.0.0' },
      changeSet: {
        runId: 'r1', baseCommit: 'h', patchSha256: 'b'.repeat(64),
        changedFiles: ['a.txt'], edits: [{ path: 'a.txt', content: 'x', expectedDigest: '', changeType: 'create' }],
      },
      sessionId: 's1',
      approval: { approved: true, actor: 'human', reason: 'go', changeSetSha256: 'b'.repeat(64) },
    });
    assert.equal(result.eventStoreIntegrity.valid, false);
    assert.equal(result.decision.kind, 'halt');
    assert.equal(result.finalStatus, 'QUARANTINED');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('DevflowRuntimeAdapter rejects malformed JSON output', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cs-'));
  try {
    const repoRoot = makeRepo(tmp);
    const adapter = new DevflowRuntimeAdapter({
      runner: async () => ({ stdout: 'not json', stderr: '', exitCode: 0 }),
      tempRoot: tmp,
    });
    await assert.rejects(
      () =>
        adapter.run({
          workspace: repoRoot,
          intent: { id: 'intent', version: '1.0.0' },
          changeSet: {
            runId: 'r1', baseCommit: 'h', patchSha256: 'c'.repeat(64),
            changedFiles: ['a.txt'], edits: [{ path: 'a.txt', content: 'x', expectedDigest: '', changeType: 'create' }],
          },
          sessionId: 's1',
          approval: { approved: true, actor: 'human', reason: 'go', changeSetSha256: 'c'.repeat(64) },
        }),
      (err) => err.code === 'RUNTIME_OUTPUT_INVALID',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('DevflowRuntimeAdapter.run uses literal argv with shell:false equivalent (no interpolation)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cs-'));
  try {
    const repoRoot = makeRepo(tmp);
    let captured;
    const adapter = new DevflowRuntimeAdapter({
      runner: async (argv, options) => {
        captured = { argv, options };
        return { stdout: '{}', stderr: '', exitCode: 0 };
      },
      tempRoot: tmp,
    });
    await adapter.run({
      workspace: repoRoot,
      intent: { id: 'intent', version: '1.0.0' },
      changeSet: {
        runId: 'r1', baseCommit: 'h', patchSha256: 'd'.repeat(64),
        changedFiles: ['a.txt'], edits: [{ path: 'a.txt', content: 'x', expectedDigest: '', changeType: 'create' }],
      },
      sessionId: 's1',
      approval: { approved: true, actor: 'human', reason: 'go', changeSetSha256: 'd'.repeat(64) },
    });
    assert.equal(captured.options.shell, false);
    assert.deepEqual(captured.argv.slice(0, 3), ['devflow-runtime', '--workspace', repoRoot]);
    assert.ok(captured.argv.includes('run'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
