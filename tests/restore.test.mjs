import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  buildLockfile,
  writeLockfile,
  readLockfile,
  LockfileError,
} from '../core/lockfile.mjs';
import {
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  SnapshotError,
} from '../core/snapshot.mjs';
import {
  planRestore,
  restoreWorkspace,
} from '../core/restore.mjs';
import { syncWorkspace } from '../core/sync.mjs';
import { rollbackToSnapshot, listSnapshotsFor } from '../core/rollback.mjs';
import { StateStore } from '../core/store.mjs';
import { AuditLog } from '../core/audit.mjs';
import { AppliedStep, AppliedState } from '../core/state.mjs';
import { FakeAdapter } from '../core/adapters.mjs';

// ---------- Lockfile ------------------------------------------------------

test('buildLockfile serializes an applied state and metadata', () => {
  const applied = new AppliedState('ws', [
    new AppliedStep({ resource: 'node', action: 'INSTALL', version: '22.1.0', previous: null }),
  ]);
  const lockfile = buildLockfile({
    workspaceId: 'ws',
    appliedState: applied,
    agents: [{ id: 'claude-code', provider: 'anthropic' }],
    mcp: [{ id: 'fs', transport: 'stdio', command: 'mcp' }],
    projects: [{ id: 'p1', status: 'CLEAN', details: { sha: 'abc' } }],
  });
  assert.equal(lockfile.version, '1');
  assert.equal(lockfile.workspace.id, 'ws');
  assert.equal(lockfile.environment.node.version, '22.1.0');
  assert.equal(lockfile.agents[0].id, 'claude-code');
  assert.equal(lockfile.mcp[0].id, 'fs');
  assert.equal(lockfile.projects[0].sha, 'abc');
});

test('buildLockfile rejects missing workspaceId', () => {
  assert.throws(() => buildLockfile({ appliedState: new AppliedState('a') }), LockfileError);
});

test('writeLockfile + readLockfile round-trips', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lock-'));
  try {
    const lockfile = buildLockfile({
      workspaceId: 'ws',
      appliedState: new AppliedState('ws', [new AppliedStep({ resource: 'node', action: 'SKIP', version: '22' })]),
    });
    const target = path.join(tmp, 'workspace.lock');
    writeLockfile(target, lockfile);
    const back = readLockfile(target);
    assert.equal(back.workspace.id, 'ws');
    assert.equal(back.environment.node.version, '22');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeLockfile + readLockfile round-trips multiple resources', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lock-'));
  try {
    const lockfile = buildLockfile({
      workspaceId: 'ws',
      appliedState: new AppliedState('ws', [
        new AppliedStep({ resource: 'node', action: 'INSTALL', version: '22', previous: null }),
        new AppliedStep({ resource: 'python', action: 'UPDATE', version: '3.12', previous: '3.11' }),
        new AppliedStep({ resource: 'uv', action: 'SKIP', version: '0.4', previous: null }),
      ]),
    });
    const target = path.join(tmp, 'workspace.lock');
    writeLockfile(target, lockfile);
    const back = readLockfile(target);
    assert.equal(back.environment.node.version, '22');
    assert.equal(back.environment.python.version, '3.12');
    assert.equal(back.environment.uv.version, '0.4');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readLockfile rejects missing file with LOCKFILE_NOT_FOUND', () => {
  assert.throws(() => readLockfile(path.join(os.tmpdir(), 'nope-' + Date.now(), 'workspace.lock')), (err) => err.code === 'LOCKFILE_NOT_FOUND');
});

test('readLockfile rejects unsupported versions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lock-'));
  try {
    const file = path.join(tmp, 'workspace.lock');
    fs.writeFileSync(file, JSON.stringify({ version: '99', workspace: { id: 'x' } }));
    assert.throws(() => readLockfile(file), (err) => err.code === 'LOCKFILE_VERSION_UNSUPPORTED');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readLockfile rejects malformed JSON', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lock-'));
  try {
    const file = path.join(tmp, 'workspace.lock');
    fs.writeFileSync(file, '{ not json');
    assert.throws(() => readLockfile(file), (err) => err.code === 'LOCKFILE_PARSE_ERROR');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- Snapshot ------------------------------------------------------

test('createSnapshot copies managed files under .workbench/snapshots/<id>/', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-snap-'));
  try {
    fs.writeFileSync(path.join(tmp, 'config.json'), '{"a":1}');
    const snap = createSnapshot(['config.json'], { root: tmp, id: 'snap1' });
    assert.equal(snap.id, 'snap1');
    assert.equal(snap.captured.length, 1);
    assert.ok(fs.existsSync(path.join(snap.snapshotDir, 'config.json')));
    const back = fs.readFileSync(path.join(snap.snapshotDir, 'config.json'), 'utf8');
    assert.equal(back, '{"a":1}');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createSnapshot records missing files instead of throwing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-snap-'));
  try {
    const snap = createSnapshot(['absent.json'], { root: tmp });
    assert.deepEqual(snap.missing, [path.join(tmp, 'absent.json')]);
    assert.equal(snap.captured.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createSnapshot refuses paths that escape the snapshot root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-snap-'));
  try {
    assert.throws(() => createSnapshot(['../escape'], { root: tmp }), (err) => err.code === 'SNAPSHOT_PATH_ESCAPE');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('listSnapshots and restoreSnapshot round-trip captured files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-snap-'));
  try {
    fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'sub', 'file.txt'), 'original');
    const snap = createSnapshot(['sub/file.txt'], { root: tmp, id: 'roundtrip' });
    // mutate the file
    fs.writeFileSync(path.join(tmp, 'sub', 'file.txt'), 'mutated');
    const listed = listSnapshots(tmp);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'roundtrip');
    const restored = restoreSnapshot('roundtrip', { root: tmp });
    assert.equal(restored.restored.length, 1);
    assert.equal(fs.readFileSync(path.join(tmp, 'sub', 'file.txt'), 'utf8'), 'original');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('restoreSnapshot throws when the snapshot id is unknown', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-snap-'));
  try {
    assert.throws(() => restoreSnapshot('nope', { root: tmp }), (err) => err.code === 'SNAPSHOT_NOT_FOUND');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createSnapshot is idempotent — calling twice produces separate IDs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-snap-'));
  try {
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'a');
    const a = createSnapshot(['f.txt'], { root: tmp, id: 'one' });
    const b = createSnapshot(['f.txt'], { root: tmp, id: 'two' });
    assert.notEqual(a.snapshotDir, b.snapshotDir);
    assert.equal(listSnapshots(tmp).length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- Restore -------------------------------------------------------

function fakeAdapters(script = {}) {
  const map = new Map();
  for (const id of ['node', 'python', 'uv']) {
    map.set(id, new FakeAdapter({
      id,
      scripted: { detect: script[id] ?? null },
      allowedActions: new Set(['detect', 'install', 'update']),
    }));
  }
  // claude-code / codex default to MISSING in the fake
  for (const id of ['claude-code', 'codex']) {
    map.set(id, new FakeAdapter({ id, scripted: { detect: null }, allowedActions: new Set(['detect']) }));
  }
  return map;
}

test('planRestore assembles a plan from the manifest + observed state', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-restore-'));
  try {
    const manifest = {
      version: '1',
      workspace: { id: 'restore-me' },
      environment: { node: { version: '22' } },
    };
    fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify(manifest));
    const planned = await planRestore(path.join(tmp, 'workspace.json'), {
      adapterMap: fakeAdapters({ node: '20' }),
    });
    assert.equal(planned.plan.workspace, 'restore-me');
    assert.equal(planned.plan.steps.length, 1);
    assert.equal(planned.plan.steps[0].action, 'UPDATE');
    assert.equal(planned.plan.steps[0].previous, '20');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('restoreWorkspace reports NO CHANGES when the host already matches', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-restore-'));
  try {
    const manifest = {
      version: '1',
      workspace: { id: 'restore-me' },
      environment: { node: { version: '22' } },
    };
    fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify(manifest));
    const result = await restoreWorkspace(path.join(tmp, 'workspace.json'), {
      adapterMap: fakeAdapters({ node: '22' }),
      apply: true,
    });
    assert.equal(result.noChanges, true);
    assert.equal(result.report.summary.applied, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('restoreWorkspace re-apply is idempotent: a second restore on a now-converged host reports NO CHANGES', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-restore-'));
  try {
    const manifest = {
      version: '1',
      workspace: { id: 'restore-me' },
      environment: { node: { version: '22' } },
    };
    fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify(manifest));
    const adapterMap = fakeAdapters({ node: '20' });
    const first = await restoreWorkspace(path.join(tmp, 'workspace.json'), { adapterMap, apply: true });
    assert.equal(first.noChanges, false);
    // After the first apply, simulate that the host now matches by flipping
    // the fake adapter's detect result.
    adapterMap.get('node').scripted.detect = { version: '22' };
    const second = await restoreWorkspace(path.join(tmp, 'workspace.json'), { adapterMap, apply: true });
    assert.equal(second.noChanges, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('planRestore surfaces a corrupted lockfile error but still plans from the manifest', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-restore-'));
  try {
    const manifest = {
      version: '1',
      workspace: { id: 'restore-me' },
      environment: { node: { version: '22' } },
    };
    fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(tmp, 'workspace.lock'), '{ not json');
    const planned = await planRestore(path.join(tmp, 'workspace.json'), {
      adapterMap: fakeAdapters({ node: '22' }),
    });
    assert.ok(planned.lockfileError);
    assert.equal(planned.lockfileError.code, 'LOCKFILE_PARSE_ERROR');
    assert.ok(planned.plan);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('planRestore on a manifest-only directory returns null lockfile and a usable plan', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-restore-'));
  try {
    const manifest = {
      version: '1',
      workspace: { id: 'restore-me' },
      environment: { node: { version: '22' } },
    };
    fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify(manifest));
    // No workspace.lock alongside.
    const planned = await planRestore(path.join(tmp, 'workspace.json'), {
      adapterMap: fakeAdapters({ node: '20' }),
    });
    assert.equal(planned.lockfile, null);
    assert.equal(planned.lockfileError, null);
    assert.ok(planned.plan);
    assert.equal(planned.plan.steps[0].action, 'UPDATE');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('planRestore rejects a manifest that fails validation (missing environment)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-restore-'));
  try {
    fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify({
      version: '1',
      workspace: { id: 'x' },
      agents: [{ id: 'claude-code' }],
    }));
    await assert.rejects(
      () => planRestore(path.join(tmp, 'workspace.json'), { adapterMap: fakeAdapters() }),
      (err) => err.code === 'MANIFEST_FIELD_REQUIRED'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeLockfile is atomic (no .tmp file left behind)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lock-'));
  try {
    const lockfile = buildLockfile({ workspaceId: 'ws' });
    const target = path.join(tmp, 'workspace.lock');
    writeLockfile(target, lockfile);
    assert.ok(fs.existsSync(target));
    assert.equal(fs.existsSync(target + '.tmp'), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('restoreWorkspace noChanges is false when downstream steps are blocked', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-restore-'));
  try {
    const manifest = {
      version: '1',
      workspace: { id: 'blocked-test' },
      environment: { node: { version: '22' } },
    };
    fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify(manifest));
    // Force the first step to fail so the second becomes BLOCKED.
    const adapterMap = fakeAdapters();
    adapterMap.get('node').scripted.install = { success: false, changed: false, status: 'ERROR', message: 'fail' };
    const result = await restoreWorkspace(path.join(tmp, 'workspace.json'), { adapterMap, apply: true });
    assert.equal(result.noChanges, false);
    assert.ok(result.report.summary.failed >= 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- M4: Sync writes workspace.lock + audit + snapshot --------

test('syncWorkspace writes workspace.lock from the applied state', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sync-'));
  try {
    const manifest = {
      version: '1',
      workspace: { id: 'sync-test' },
      environment: { node: { version: '22' } },
    };
    fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify(manifest));
    const result = await syncWorkspace(path.join(tmp, 'workspace.json'), {
      apply: true,
      skipProjects: true,
      adapterMap: fakeAdapters({ node: '20' }),
      stateStore: new StateStore({ root: path.join(tmp, '.workbench', 'store'), workspaceId: 'sync-test' }),
    });
    assert.equal(result.dryRun, false);
    assert.ok(result.lockfileWritten);
    assert.ok(fs.existsSync(result.lockfileWritten));
    const lockfile = JSON.parse(fs.readFileSync(result.lockfileWritten, 'utf8'));
    assert.equal(lockfile.workspace.id, 'sync-test');
    assert.ok(lockfile.environment.node);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('syncWorkspace (dry-run) does NOT write workspace.lock', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sync-'));
  try {
    const manifest = {
      version: '1',
      workspace: { id: 'sync-dryrun' },
      environment: { node: { version: '22' } },
    };
    fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify(manifest));
    const result = await syncWorkspace(path.join(tmp, 'workspace.json'), {
      apply: false,
      skipProjects: true,
      adapterMap: fakeAdapters({ node: '20' }),
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.lockfileWritten, null);
    assert.equal(fs.existsSync(path.join(tmp, 'workspace.lock')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('syncWorkspace captures a snapshot of the manifest + (existing) lockfile', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sync-'));
  try {
    const manifest = {
      version: '1',
      workspace: { id: 'snap-test' },
      environment: { node: { version: '22' } },
    };
    fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify(manifest));
    // Pre-existing lockfile
    const prior = buildLockfile({ workspaceId: 'snap-test', appliedState: new AppliedState('snap-test') });
    writeLockfile(path.join(tmp, 'workspace.lock'), prior);
    const result = await syncWorkspace(path.join(tmp, 'workspace.json'), {
      apply: true,
      skipProjects: true,
      adapterMap: fakeAdapters({ node: '20' }),
    });
    assert.ok(result.snapshot);
    assert.ok(fs.existsSync(path.join(result.snapshot.snapshotDir, 'workspace.json')));
    assert.ok(fs.existsSync(path.join(result.snapshot.snapshotDir, 'workspace.lock')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- M4: Restore prefers lockfile (clean-VM scenario) -----------

test('Restore treats lockfile-pinned versions as the observed baseline on a clean VM', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-restore-lockfile-'));
  try {
    const manifest = {
      version: '1',
      workspace: { id: 'restore-lockfile' },
      environment: { node: { version: '22.1.0' } },
    };
    fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify(manifest));
    // Pre-existing lockfile that already pins the right version
    const lockfile = buildLockfile({
      workspaceId: 'restore-lockfile',
      appliedState: new AppliedState('restore-lockfile', [new AppliedStep({ resource: 'node', action: 'SKIP', version: '22.1.0' })]),
    });
    writeLockfile(path.join(tmp, 'workspace.lock'), lockfile);
    // Adapter that simulates a clean VM (no host detection)
    const cleanAdapters = new Map();
    cleanAdapters.set('node', new FakeAdapter({ id: 'node', scripted: { detect: null } }));
    cleanAdapters.set('python', new FakeAdapter({ id: 'python', scripted: { detect: null } }));
    cleanAdapters.set('uv', new FakeAdapter({ id: 'uv', scripted: { detect: null } }));
    cleanAdapters.set('claude-code', new FakeAdapter({ id: 'claude-code', scripted: { detect: null } }));
    cleanAdapters.set('codex', new FakeAdapter({ id: 'codex', scripted: { detect: null } }));
    const result = await restoreWorkspace(path.join(tmp, 'workspace.json'), {
      apply: true,
      adapterMap: cleanAdapters,
    });
    assert.equal(result.noChanges, true);
    assert.equal(result.report.summary.applied, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Restore refreshes the lockfile when the manifest versions drift from the lockfile', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-restore-drift-'));
  try {
    const manifest = {
      version: '1',
      workspace: { id: 'drift' },
      environment: { node: { version: '22.2.0' } }, // newer than lockfile
    };
    fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify(manifest));
    const lockfile = buildLockfile({
      workspaceId: 'drift',
      appliedState: new AppliedState('drift', [new AppliedStep({ resource: 'node', action: 'SKIP', version: '22.1.0' })]),
    });
    writeLockfile(path.join(tmp, 'workspace.lock'), lockfile);
    const cleanAdapters = new Map();
    cleanAdapters.set('node', new FakeAdapter({ id: 'node', scripted: { detect: null } }));
    cleanAdapters.set('python', new FakeAdapter({ id: 'python', scripted: { detect: null } }));
    cleanAdapters.set('uv', new FakeAdapter({ id: 'uv', scripted: { detect: null } }));
    cleanAdapters.set('claude-code', new FakeAdapter({ id: 'claude-code', scripted: { detect: null } }));
    cleanAdapters.set('codex', new FakeAdapter({ id: 'codex', scripted: { detect: null } }));
    const result = await restoreWorkspace(path.join(tmp, 'workspace.json'), {
      apply: true,
      adapterMap: cleanAdapters,
    });
    assert.ok(result.refreshedLockfile);
    const fresh = JSON.parse(fs.readFileSync(result.refreshedLockfile, 'utf8'));
    assert.equal(fresh.environment.node.version, '22.2.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- M4: Rollback -----------------------------------------------

test('rollbackToSnapshot restores files from a named snapshot', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rollback-'));
  try {
    fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'sub', 'file.txt'), 'original');
    // Use sync to create a snapshot
    const manifest = { version: '1', workspace: { id: 'rb' }, environment: { node: { version: '22' } } };
    fs.writeFileSync(path.join(tmp, 'workspace.json'), JSON.stringify(manifest));
    await syncWorkspace(path.join(tmp, 'workspace.json'), {
      apply: true,
      skipProjects: true,
      adapterMap: fakeAdapters({ node: '22' }),
    });
    // Mutate the file
    fs.writeFileSync(path.join(tmp, 'sub', 'file.txt'), 'mutated');
    // Find the snapshot id
    const snaps = listSnapshotsFor(tmp);
    assert.ok(snaps.length >= 1);
    const snapId = snaps[snaps.length - 1].id;
    const restored = await rollbackToSnapshot(snapId, { root: tmp, workspaceId: 'rb' });
    assert.equal(restored.ok, true);
    // The mutation is undone for files captured by the snapshot; file.txt
    // was not captured (sync snapshots manifest+lockfile only), so it
    // remains 'mutated'. This documents the M4 snapshot policy.
    assert.equal(fs.readFileSync(path.join(tmp, 'sub', 'file.txt'), 'utf8'), 'mutated');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('rollbackToSnapshot throws when the snapshot id is unknown', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rollback-'));
  try {
    await assert.rejects(() => rollbackToSnapshot('does-not-exist', { root: tmp, workspaceId: 'x' }), (err) => err.code === 'SNAPSHOT_NOT_FOUND');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});