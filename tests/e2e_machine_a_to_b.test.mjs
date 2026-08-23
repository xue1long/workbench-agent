// E2E acceptance test for M4: Machine A → Sync → Git → Machine B → Restore.
//
// Per spec §34: the canonical Level-1 acceptance scenario. We simulate it
// inside the same test process using two tmp directories ("machineA" and
// "machineB") + a real git CLI, with no network involvement.
//
// Stages:
//   1. machineA: write a workspace.json
//   2. machineA: `workbench sync --apply` (writes lockfile, captures snapshot)
//   3. machineA: `git init && git add . && git commit` (commits lockfile)
//   4. machineB: `git clone machineA/.git machineB` (bare clone into fresh dir)
//   5. machineB: `workbench restore` (reads manifest + lockfile, reports NO CHANGES)
//   6. machineB: re-`workbench restore` (still NO CHANGES — idempotent)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { syncWorkspace } from '../core/sync.mjs';
import { restoreWorkspace } from '../core/restore.mjs';
import { StateStore } from '../core/store.mjs';
import { AuditLog } from '../core/audit.mjs';
import { FakeAdapter } from '../core/adapters.mjs';

function git(cwd, args, opts = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return { status: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-'));
}

function fakeAdapters(script = {}) {
  const map = new Map();
  for (const id of ['node', 'python', 'uv']) {
    map.set(id, new FakeAdapter({ id, scripted: { detect: script[id] ?? null }, allowedActions: new Set(['detect', 'install', 'update']) }));
  }
  for (const id of ['claude-code', 'codex']) {
    map.set(id, new FakeAdapter({ id, scripted: { detect: null }, allowedActions: new Set(['detect']) }));
  }
  return map;
}

test('M4 E2E: machine A sync → git → machine B restore (NO CHANGES)', async () => {
  // Bail early if git isn't usable on this machine.
  const probe = git(os.tmpdir(), ['--version']);
  if (probe.status !== 0) {
    assert.fail(`git is not available: ${probe.stderr}`);
    return;
  }

  const workspaceRoot = tmpRoot();
  const machineA = path.join(workspaceRoot, 'machineA');
  const machineB = path.join(workspaceRoot, 'machineB');
  fs.mkdirSync(machineA);
  fs.mkdirSync(machineB);

  // ----- 1. machineA: write workspace.json ---------------------------------
  const manifest = {
    version: '1',
    workspace: { id: 'e2e-workspace' },
    environment: {
      node: { version: '22.1.0' },
      python: { version: '3.12.4' },
      uv: { version: '0.4.18' },
    },
    agents: [{ id: 'claude-code' }],
    mcp: [{ id: 'filesystem', transport: 'stdio', command: 'mcp-fs', args: [] }],
  };
  const manifestPath = path.join(machineA, 'workspace.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  // ----- 2. machineA: workbench sync --apply (writes lockfile) -------------
  const workspaceId = manifest.workspace.id;
  const stateStoreA = new StateStore({ root: path.join(machineA, '.workbench', 'store'), workspaceId });
  const auditA = new AuditLog({ workspaceId, store: stateStoreA });
  // Pretend the host already matches the manifest — adapter detect returns
  // the desired versions so the plan is all SKIP, but the lockfile is still
  // written and pinned.
  const syncResult = await syncWorkspace(manifestPath, {
    apply: true,
    skipAllProjects: true,
    adapterMap: fakeAdapters({ node: '22.1.0', python: '3.12.4', uv: '0.4.18' }),
    stateStore: stateStoreA,
    audit: auditA,
  });
  assert.equal(syncResult.dryRun, false);
  assert.ok(syncResult.lockfileWritten);
  assert.ok(fs.existsSync(syncResult.lockfileWritten));

  // ----- 3. machineA: git init + commit --------------------------------------
  assert.equal(git(machineA, ['init', '-q']).status, 0, 'git init failed');
  // git refuses to commit without user.name/email; configure locally.
  git(machineA, ['config', 'user.email', 'e2e@example.com']);
  git(machineA, ['config', 'user.name', 'Workbench E2E']);
  git(machineA, ['config', 'commit.gpgsign', 'false']);
  assert.equal(git(machineA, ['add', 'workspace.json', 'workspace.lock', '.workbench']).status, 0, 'git add failed');
  const commit = git(machineA, ['commit', '-q', '-m', 'sync']);
  assert.equal(commit.status, 0, `git commit failed: ${commit.stderr}`);

  // ----- 4. machineB: git clone machineA into machineB -----------------------
  const clone = git(machineB, ['clone', machineA, '.']);
  assert.equal(clone.status, 0, `git clone failed: ${clone.stderr}`);
  assert.ok(fs.existsSync(path.join(machineB, 'workspace.json')));
  assert.ok(fs.existsSync(path.join(machineB, 'workspace.lock')));

  // ----- 5. machineB: workbench restore --apply -----------------------------
  // The clean VM has no `node`/`python`/`uv` detected (FakeAdapter with
  // detect=null simulates "missing"). The lockfile override should kick in
  // and produce NO CHANGES.
  const cleanAdapters = new Map();
  for (const id of ['node', 'python', 'uv', 'claude-code', 'codex']) {
    cleanAdapters.set(id, new FakeAdapter({ id, scripted: { detect: null }, allowedActions: new Set(['detect', 'install', 'update']) }));
  }
  const restore1 = await restoreWorkspace(path.join(machineB, 'workspace.json'), {
    apply: true,
    adapterMap: cleanAdapters,
  });
  assert.equal(restore1.workspace, workspaceId);
  assert.equal(restore1.lockfileError, null, `lockfile read failed: ${restore1.lockfileError?.message}`);
  assert.ok(restore1.lockfile, 'lockfile should be read by restore');
  assert.equal(restore1.noChanges, true, `first restore should be NO CHANGES, got: ${JSON.stringify(restore1.report.summary)}`);
  assert.equal(restore1.report.summary.applied, 0);

  // ----- 6. machineB: re-restore is still NO CHANGES (idempotency) ---------
  const restore2 = await restoreWorkspace(path.join(machineB, 'workspace.json'), {
    apply: true,
    adapterMap: cleanAdapters,
  });
  assert.equal(restore2.noChanges, true);
  assert.equal(restore2.report.summary.applied, 0);

  // Clean up.
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('M4 E2E: lockfile drift is corrected by a subsequent restore', async () => {
  const probe = git(os.tmpdir(), ['--version']);
  if (probe.status !== 0) return;

  const workspaceRoot = tmpRoot();
  const machineA = path.join(workspaceRoot, 'machineA');
  const machineB = path.join(workspaceRoot, 'machineB');
  fs.mkdirSync(machineA);
  fs.mkdirSync(machineB);

  // Initial sync writes a lockfile pinning node@22.1.0.
  const manifest = {
    version: '1',
    workspace: { id: 'drift' },
    environment: { node: { version: '22.1.0' } },
  };
  fs.writeFileSync(path.join(machineA, 'workspace.json'), JSON.stringify(manifest));
  await syncWorkspace(path.join(machineA, 'workspace.json'), {
    apply: true,
    skipAllProjects: true,
    adapterMap: fakeAdapters({ node: '22.1.0' }),
  });
  git(machineA, ['init', '-q']);
  git(machineA, ['config', 'user.email', 'e2e@example.com']);
  git(machineA, ['config', 'user.name', 'Workbench E2E']);
  git(machineA, ['config', 'commit.gpgsign', 'false']);
  git(machineA, ['add', '-A']);
  git(machineA, ['commit', '-q', '-m', 'initial']);

  // Clone on machineB.
  assert.equal(git(machineB, ['clone', machineA, '.']).status, 0);

  // Drift the manifest on machineB (simulates a user editing the manifest
  // before running restore). Lockfile still pins 22.1.0; manifest says 22.2.0.
  const drifted = JSON.parse(fs.readFileSync(path.join(machineB, 'workspace.json'), 'utf8'));
  drifted.environment.node.version = '22.2.0';
  fs.writeFileSync(path.join(machineB, 'workspace.json'), JSON.stringify(drifted));

  const cleanAdapters = new Map();
  for (const id of ['node', 'python', 'uv', 'claude-code', 'codex']) {
    cleanAdapters.set(id, new FakeAdapter({ id, scripted: { detect: null }, allowedActions: new Set(['detect', 'install', 'update']) }));
  }
  const restore1 = await restoreWorkspace(path.join(machineB, 'workspace.json'), {
    apply: true,
    adapterMap: cleanAdapters,
  });
  assert.ok(restore1.refreshedLockfile, 'drift must trigger a lockfile refresh');
  const fresh = JSON.parse(fs.readFileSync(restore1.refreshedLockfile, 'utf8'));
  assert.equal(fresh.environment.node.version, '22.2.0');

  // Second restore on machineB is now NO CHANGES (drift resolved).
  const restore2 = await restoreWorkspace(path.join(machineB, 'workspace.json'), {
    apply: true,
    adapterMap: cleanAdapters,
  });
  assert.equal(restore2.noChanges, true);

  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});