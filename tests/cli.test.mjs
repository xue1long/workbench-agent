import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { run } from '../src/workbench.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-'));
}

function writeManifest(root, manifest) {
  const target = path.join(root, 'workspace.json');
  fs.writeFileSync(target, JSON.stringify(manifest));
  return target;
}

const validManifest = {
  version: '1',
  workspace: { id: 'cli-test' },
  environment: { node: { version: '22' }, python: { version: '3.12' } },
  agents: [{ id: 'claude-code' }],
  mcp: [{ id: 'filesystem', transport: 'stdio', command: 'mcp', args: [] }],
  projects: [{ id: 'notes', source: { type: 'local' }, path: 'projects/notes' }],
};

// ---------- init ---------------------------------------------------------

test('CLI init writes a starter workspace.json', async () => {
  const root = tmpRoot();
  try {
    const code = await run(['init'], { write: () => {} }, { write: () => {} }, root);
    assert.equal(code, 0);
    const target = path.join(root, 'workspace.json');
    assert.ok(fs.existsSync(target));
    const back = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(back.version, '1');
    assert.ok(back.workspace.id);
    assert.ok(back.environment.node);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI init refuses to overwrite an existing workspace.json', async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'workspace.json'), '{}');
    const stderr = [];
    const code = await run(['init'], { write: () => {} }, { write: (c) => stderr.push(c) }, root);
    assert.equal(code, 1);
    assert.match(stderr.join(''), /already exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- plan / apply / verify ---------------------------------------

test('CLI plan reads workspace.json from cwd', async () => {
  const root = tmpRoot();
  try {
    writeManifest(root, validManifest);
    const stdout = [];
    const code = await run(['plan'], { write: (c) => stdout.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    const out = stdout.join('');
    assert.match(out, /Workspace: cli-test/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI verify prints a health summary', async () => {
  const root = tmpRoot();
  try {
    writeManifest(root, validManifest);
    const stdout = [];
    const code = await run(['verify'], { write: (c) => stdout.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    const out = stdout.join('');
    assert.match(out, /Workspace: cli-test/);
    assert.match(out, /Health: PASS/);
    assert.match(out, /Resources: node, python/);
    assert.match(out, /MCP: filesystem/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI status prints observed + plan', async () => {
  const root = tmpRoot();
  try {
    writeManifest(root, validManifest);
    const stdout = [];
    const code = await run(['status'], { write: (c) => stdout.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    const out = stdout.join('');
    assert.match(out, /Workspace: cli-test/);
    assert.match(out, /Observed:/);
    assert.match(out, /Plan: \d+ step/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- project / agent / mcp list ---------------------------------

test('CLI project list enumerates declared projects', async () => {
  const root = tmpRoot();
  try {
    writeManifest(root, validManifest);
    const stdout = [];
    const code = await run(['project', 'list'], { write: (c) => stdout.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    const out = stdout.join('');
    assert.match(out, /Projects \(1\):/);
    assert.match(out, /notes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI agent list merges manifest + builtins', async () => {
  const root = tmpRoot();
  try {
    writeManifest(root, validManifest);
    const stdout = [];
    const code = await run(['agent', 'list'], { write: (c) => stdout.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    const out = stdout.join('');
    assert.match(out, /Agents \(\d+\):/);
    assert.match(out, /claude-code/);
    assert.match(out, /codex/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI mcp list enumerates declared MCP servers', async () => {
  const root = tmpRoot();
  try {
    writeManifest(root, validManifest);
    const stdout = [];
    const code = await run(['mcp', 'list'], { write: (c) => stdout.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    const out = stdout.join('');
    assert.match(out, /MCP \(1\):/);
    assert.match(out, /filesystem/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI package list enumerates declared packages', async () => {
  const root = tmpRoot();
  try {
    const manifest = {
      ...validManifest,
      packages: [{ id: 'pkg-skill-a', type: 'skill', version: '1.0.0' }],
    };
    writeManifest(root, manifest);
    const stdout = [];
    const code = await run(['package', 'list'], { write: (c) => stdout.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    const out = stdout.join('');
    assert.match(out, /Packages \(1\):/);
    assert.match(out, /pkg-skill-a/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- sync / restore ---------------------------------------------

test('CLI sync (dry-run) without projects reports a clean preview', async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify({
      version: '1',
      workspace: { id: 'no-projects' },
      environment: { node: { version: '24' } }, // matches the test host so the plan yields SKIP
    }));
    const stdout = [];
    const code = await run(['sync', '--no-git'], { write: (c) => stdout.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    const out = stdout.join('');
    assert.match(out, /Workspace: no-projects/);
    assert.match(out, /NO CHANGES|applied=0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI sync with a local project creates the project directory', async () => {
  const root = tmpRoot();
  try {
    writeManifest(root, validManifest);
    const stdout = [];
    const code = await run(['sync', '--apply', '--no-git'], { write: (c) => stdout.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    assert.ok(fs.existsSync(path.join(root, 'projects', 'notes')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI restore (dry-run) reads workspace.json and prints a plan', async () => {
  const root = tmpRoot();
  try {
    writeManifest(root, validManifest);
    const stdout = [];
    const code = await run(['restore'], { write: (c) => stdout.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    const out = stdout.join('');
    assert.match(out, /Workspace: cli-test/);
    assert.match(out, /Mode: dry-run/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- rollback -----------------------------------------------------

test('CLI rollback --to requires a snapshot id', async () => {
  const stderr = [];
  const code = await run(['rollback'], { write: () => {} }, { write: (c) => stderr.push(c) }, tmpRoot());
  assert.equal(code, 1);
  assert.match(stderr.join(''), /--to <snapshotId>/);
});

test('CLI rollback --to <unknown> exits 1 with a list of available snapshots', async () => {
  const root = tmpRoot();
  try {
    // Pre-create the .workbench/snapshots dir to enable the lookup path.
    fs.mkdirSync(path.join(root, '.workbench', 'snapshots'), { recursive: true });
    fs.mkdirSync(path.join(root, '.workbench', 'snapshots', 'snap-existing'), { recursive: true });
    const stderr = [];
    const code = await run(['rollback', '--to', 'snap-missing'], { write: () => {} }, { write: (c) => stderr.push(c) }, root);
    assert.equal(code, 1);
    assert.match(stderr.join(''), /snap-missing/);
    assert.match(stderr.join(''), /snap-existing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI rollback --to <snap> restores files', async () => {
  const root = tmpRoot();
  try {
    // First, generate a workspace.json and sync (apply) to create a snapshot.
    fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify({
      version: '1',
      workspace: { id: 'rb-cli' },
      environment: { node: { version: '22' } },
    }));
    await run(['sync', '--apply', '--no-git'], { write: () => {} }, { write: () => {} }, root);
    // Find the snapshot id.
    const { listSnapshotsFor } = await import('../core/rollback.mjs');
    const list = listSnapshotsFor(root);
    assert.ok(list.length >= 1, 'sync must create a snapshot');
    const snapId = list[list.length - 1].id;
    const stdout = [];
    const code = await run(['rollback', '--to', snapId], { write: (c) => stdout.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    assert.match(stdout.join(''), /Rolled back/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- unknown command ---------------------------------------------

test('CLI rejects unknown top-level commands with exit 2', async () => {
  const stderr = [];
  const code = await run(['nope'], { write: () => {} }, { write: (c) => stderr.push(c) });
  assert.equal(code, 2);
  assert.match(stderr.join(''), /unknown command/);
});

test('CLI rejects unknown subcommand of `project` with exit 2', async () => {
  const stderr = [];
  const code = await run(['project', 'nope'], { write: () => {} }, { write: (c) => stderr.push(c) });
  assert.equal(code, 2);
  assert.match(stderr.join(''), /unknown command/);
});

// ---------- error paths -------------------------------------------------

test('CLI surfaces a clean ManifestError on invalid manifest', async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify({ version: '1' /* missing workspace/environment */ }));
    const stderr = [];
    const code = await run(['plan'], { write: () => {} }, { write: (c) => stderr.push(c) }, root);
    assert.equal(code, 1);
    assert.match(stderr.join(''), /workbench: /);
    assert.doesNotMatch(stderr.join(''), /at .+\.mjs:\d+/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});