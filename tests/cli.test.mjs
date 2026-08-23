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

// ---------- task subcommand (Level 2) ------------------------------------

function makeTaskGraphPayload() {
  return {
    task: { id: 't-cli', goal: 'ship it' },
    nodes: [
      { id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] },
      { id: 'b', goal: 'b', dependencies: ['a'], acceptanceCriteria: [{ id: 'bb', verifierRef: 'diff', required: true }] },
    ],
  };
}

test('CLI task validate accepts a valid graph file', async () => {
  const root = tmpRoot();
  try {
    const file = path.join(root, 'graph.json');
    fs.writeFileSync(file, JSON.stringify(makeTaskGraphPayload()), 'utf8');
    const out = [];
    const code = await run(['task', 'validate', '--file', file], { write: (c) => out.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    assert.match(out.join(''), /2 node\(s\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI task validate rejects a cyclic graph file', async () => {
  const root = tmpRoot();
  try {
    const file = path.join(root, 'graph.json');
    fs.writeFileSync(file, JSON.stringify({
      task: { id: 't', goal: 'g' },
      nodes: [
        { id: 'a', goal: 'a', dependencies: ['b'], acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] },
        { id: 'b', goal: 'b', dependencies: ['a'], acceptanceCriteria: [{ id: 'bb', verifierRef: 'diff', required: true }] },
      ],
    }), 'utf8');
    const err = [];
    const code = await run(['task', 'validate', '--file', file], { write: () => {} }, { write: (c) => err.push(c) }, root);
    assert.equal(code, 2);
    assert.match(err.join(''), /cycle/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI task simulate runs a deterministic graph', async () => {
  const root = tmpRoot();
  try {
    const file = path.join(root, 'graph.json');
    fs.writeFileSync(file, JSON.stringify(makeTaskGraphPayload()), 'utf8');
    const out = [];
    const code = await run(['task', 'simulate', '--file', file], { write: (c) => out.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    assert.match(out.join(''), /EXECUTION_SUCCEEDED/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI task simulate rejects out-of-range concurrency', async () => {
  const root = tmpRoot();
  try {
    const file = path.join(root, 'graph.json');
    fs.writeFileSync(file, JSON.stringify(makeTaskGraphPayload()), 'utf8');
    const err = [];
    const code = await run(['task', 'simulate', '--file', file, '--concurrency', '99'], { write: () => {} }, { write: (c) => err.push(c) }, root);
    assert.equal(code, 2);
    assert.match(err.join(''), /concurrency/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI task run requires a Git working copy', async () => {
  const root = tmpRoot();
  try {
    const err = [];
    const code = await run(['task', 'run', '--goal', 'noop'], { write: () => {} }, { write: (c) => err.push(c) }, root);
    assert.equal(code, 2);
    assert.match(err.join(''), /Git/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI task run without --approve-changes preserves candidate and returns AWAITING_APPROVAL', async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'README.md'), 'init\n');
    const { spawnSync } = await import('node:child_process');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'cli@l'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'cli'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
    // Inject mock dependencies so the CLI run does not require live agents
    // or a real DevFlow Runtime invocation.
    const mockDeps = {
      repoRoot: root,
      planner: { plan: async () => ({
        task: { id: 'cli-task', goal: 'noop', inputHash: 'h'.repeat(64) },
        nodes: [{ id: 'plan', goal: 'noop', definitionHash: 'h'.repeat(64), dependencies: [], capabilityRequired: 'coding', requiredTools: [], acceptanceCriteria: [{ id: 'pa', verifierRef: 'diff', required: true }] }],
        nodeIds: ['plan'],
        graphHash: 'h'.repeat(64),
      }) },
      invoker: { invoke: async () => ({ success: true, evidenceClaims: [], output: {}, cost: 0, usage: {}, message: '' }) },
      changeSandbox: {
        create: async () => ({ repoRoot: root, sandboxPath: root, runId: 'r', baseCommit: 'h', async cleanup() {} }),
        collect: async () => ({ runId: 'r', baseCommit: 'h', patchSha256: 'a'.repeat(64), changedFiles: ['README.md'], edits: [{ path: 'README.md', content: 'init\n', expectedDigest: '', changeType: 'replace' }], sandboxPath: root }),
      },
      runtime: { run: async () => ({ sessionId: 's', stateRevision: 0, actionStatus: 'applied', blockingReasons: [], evidenceIds: [], decision: { kind: 'halt', reason: 'no Runtime call' }, eventStoreIntegrity: { valid: true, last_sequence: 0, error: null }, finalStatus: 'AWAITING_APPROVAL' }) },
      agents: { list: () => [{ id: 'mock', capabilities: ['coding'], tools: [], maxRisk: 'low', maxContextTokens: 32000 }] },
      audit: { agentSelected: () => {}, toolCalled: () => {}, runtimeDecided: () => {} },
    };
    const out = [];
    const code = await run(['task', 'run', '--goal', 'noop'], { write: (c) => out.push(c) }, { write: () => {} }, root, { deps: mockDeps });
    assert.notEqual(code, 0);
    assert.match(out.join(''), /finalStatus/);
    assert.match(out.join(''), /AWAITING_APPROVAL/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
// ---------- Level 3 Task 5: pipeline CLI ---------------------------------

import { StateStore } from '../core/store.mjs';
import { Orchestrator } from '../core/orchestrator.mjs';
import { DevflowRuntimeAdapter } from '../adapters/devflow-runtime.mjs';
import { spawnSync } from 'node:child_process';

function makeGitRoot() {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'README.md'), 'init\n');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'cli@l'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'cli'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  return root;
}

const STAGE_OUTPUTS = {
  requirement: 'requirement-notes',
  analysis: 'analysis',
  plan: 'plan',
  implementation: 'implementation-artifact',
  test: 'test-report',
  review: 'review-decision',
};

function makePipelineEnv(root) {
  const store = StateStore.open('default', { root: path.join(root, '.workbench', 'store') });
  const artifactsRoot = path.join(root, '.workbench', 'pipelines');
  const invoker = { invoke: async (agent, node) => ({
    success: true,
    evidenceClaims: [{ kind: 'artifact', payload: { ref: node.id } }],
    output: { artifacts: [{ name: STAGE_OUTPUTS[node.id] ?? 'out', content: `# ${node.id}\n`, kind: 'md' }] },
    cost: 0,
    usage: {},
    message: 'ok',
  }) };
  const changeSandbox = {
    create: async () => ({ repoRoot: root, sandboxPath: root, runId: 'r', baseCommit: 'h', async cleanup() {} }),
    collect: async () => ({ runId: 'r', baseCommit: 'h', patchSha256: 'a'.repeat(64), changedFiles: ['README.md'], edits: [{ path: 'README.md', content: 'init\n', expectedDigest: '', changeType: 'replace' }], sandboxPath: root }),
  };
  const runtime = new DevflowRuntimeAdapter({
    runner: async () => ({ stdout: JSON.stringify({
      session: { id: 's', intent_version: '1.0.0', policy_version: '1.0.0', state_revision: 1, status: 'active' },
      state_revision: 1, status: 'applied', blocking_reasons: [], evidence_ids: ['e'],
      decision: { kind: 'finish', reason: 'ok' }, event_store_integrity: { valid: true, last_sequence: 5, error: null },
    }), stderr: '', exitCode: 0 }),
    tempRoot: root,
  });
  const orchestrator = new Orchestrator({
    repoRoot: root,
    planner: { plan: async () => { throw new Error('pipeline CLI must not plan'); } },
    invoker,
    changeSandbox,
    runtime,
    agents: { list: () => [{ id: 'fixture', capabilities: ['requirement', 'analysis', 'planning', 'implementation', 'testing', 'reviewer'], tools: [], maxRisk: 'high', maxContextTokens: 32000 }] },
    audit: { agentSelected: () => {} },
  });
  return { store, artifactsRoot, orchestrator };
}

test('CLI pipeline list prints the standard template', async () => {
  const out = [];
  const code = await run(['pipeline', 'list'], { write: (c) => out.push(c) }, { write: () => {} }, tmpRoot());
  assert.equal(code, 0);
  assert.match(out.join(''), /standard-development/);
  assert.match(out.join(''), /requirement → analysis → plan → implementation → test → review/);
});

test('CLI pipeline simulate compiles a template without executing', async () => {
  const out = [];
  const code = await run(['pipeline', 'simulate', '--template', 'standard-development', '--goal', 'Add OAuth'], { write: (c) => out.push(c) }, { write: () => {} }, tmpRoot());
  assert.equal(code, 0);
  const text = out.join('');
  assert.match(text, /simulated, no execution/);
  assert.match(text, /implementation \[work\] deps=plan acceptance=scope/);
  assert.match(text, /review \[review\] deps=test acceptance=audit/);
});

test('CLI pipeline simulate rejects unknown templates', async () => {
  const err = [];
  const code = await run(['pipeline', 'simulate', '--template', 'nope', '--goal', 'x'], { write: () => {} }, { write: (c) => err.push(c) }, tmpRoot());
  assert.equal(code, 2);
  assert.match(err.join(''), /unknown pipeline template/);
});

test('CLI pipeline run with approval maps Runtime finish to exit 0 and COMPLETED', async () => {
  const root = makeGitRoot();
  try {
    const env = makePipelineEnv(root);
    const out = [];
    const code = await run(
      ['pipeline', 'run', '--template', 'standard-development', '--goal', 'Add OAuth', '--approve-changes'],
      { write: (c) => out.push(c) },
      { write: () => {} },
      root,
      { pipeline: env },
    );
    assert.equal(code, 0);
    const text = out.join('');
    assert.match(text, /finalStatus: COMPLETED/);
    assert.match(text, /executionStatus: EXECUTION_SUCCEEDED/);
    assert.match(text, /stages: requirement=SUCCEEDED analysis=SUCCEEDED plan=SUCCEEDED implementation=SUCCEEDED test=SUCCEEDED review=SUCCEEDED/);
    assert.match(text, /artifacts: 6/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI pipeline run without approval stops at AWAITING_APPROVAL', async () => {
  const root = makeGitRoot();
  try {
    const env = makePipelineEnv(root);
    const out = [];
    const code = await run(
      ['pipeline', 'run', '--template', 'standard-development', '--goal', 'Add OAuth'],
      { write: (c) => out.push(c) },
      { write: () => {} },
      root,
      { pipeline: env },
    );
    assert.notEqual(code, 0);
    assert.match(out.join(''), /finalStatus: AWAITING_APPROVAL/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI pipeline status shows recorded stage states', async () => {
  const root = makeGitRoot();
  try {
    const env = makePipelineEnv(root);
    const runOut = [];
    const runCode = await run(
      ['pipeline', 'run', '--template', 'standard-development', '--goal', 'Add OAuth', '--approve-changes'],
      { write: (c) => runOut.push(c) },
      { write: () => {} },
      root,
      { pipeline: env },
    );
    assert.equal(runCode, 0);
    const runId = /runId: ([^\s]+)/.exec(runOut.join(''))[1];
    const out = [];
    const code = await run(['pipeline', 'status', '--pipeline-id', 'standard-development', '--run-id', runId], { write: (c) => out.push(c) }, { write: () => {} }, root);
    assert.equal(code, 0);
    assert.match(out.join(''), /review: SUCCEEDED artifacts=1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
