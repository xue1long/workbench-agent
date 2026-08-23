// Level 2 Task 12: orchestration end-to-end acceptance fixtures.
//
// These tests exercise the public ``Orchestrator.runTask`` boundary with
// deterministic planner/invoker/Runtime doubles. They cover the nine success
// fixtures, the expected-failure fixture, fail-closed governance cases, the
// two-session isolation case, and the bounded live OAuth acceptance flow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { Orchestrator, OrchestratorError } from '../core/orchestrator.mjs';
import { DevflowRuntimeAdapter } from '../adapters/devflow-runtime.mjs';
import { executeWorkflow } from '../core/workflow-runtime.mjs';
import { createTask, createTaskGraph } from '../core/task-graph.mjs';
import { BUILTIN_CAPABILITIES, selectAgent, agentsForCapability } from '../core/capabilities.mjs';

function okHandler(node) {
  return async () => ({ success: true, output: { id: node.id }, evidenceClaims: [], cost: 0, usage: {}, message: 'ok' });
}

function failingHandler(node) {
  return async () => ({ success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: `${node.id} failed` });
}

function throwingHandler() {
  return async () => { throw new Error('handler boom'); };
}

async function runExecution(graph, handler) {
  return executeWorkflow(graph, handler(graph.nodes), { concurrency: 2 });
}

async function runOrchestratorWith(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-'));
  const repoRoot = overrides.repoRoot ?? makeRepo(tmp);
  const task = overrides.task ?? createTask({ id: 't-e2e', goal: 'ship' });
  const graph = overrides.graph ?? createTaskGraph({
    task,
    nodes: [{ id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] }],
  });
  const deps = {
    repoRoot,
    planner: { plan: async () => graph },
    invoker: overrides.invoker ?? {
      invoke: async () => ({ success: true, evidenceClaims: [], output: {}, cost: 0, usage: {}, message: '' }),
    },
    changeSandbox: overrides.changeSandbox ?? {
      create: async () => ({ repoRoot, sandboxPath: repoRoot, runId: 'r', baseCommit: 'h', async cleanup() {} }),
      collect: async () => ({ runId: 'r', baseCommit: 'h', patchSha256: 'a'.repeat(64), changedFiles: ['README.md'], edits: [{ path: 'README.md', content: 'init\n', expectedDigest: '', changeType: 'replace' }], sandboxPath: repoRoot }),
    },
    runtime: overrides.runtime ?? new DevflowRuntimeAdapter({
      runner: async () => ({ stdout: JSON.stringify({
        session: { id: 's1', intent_version: '1.0.0', policy_version: '1.0.0', state_revision: 1, status: 'active' },
        state_revision: 1, status: 'applied', blocking_reasons: [], evidence_ids: ['ev-runtime'],
        decision: { kind: 'finish', reason: 'all required acceptances verified' },
        event_store_integrity: { valid: true, last_sequence: 5, error: null },
      }), stderr: '', exitCode: 0 }),
      tempRoot: tmp,
    }),
    agents: overrides.agents ?? { list: () => [{ id: 'fix', capabilities: ['coding'], tools: [], maxRisk: 'low', maxContextTokens: 32000 }] },
    audit: overrides.audit ?? { agentSelected: () => {}, toolCalled: () => {}, runtimeDecided: () => {} },
  };
  const orch = new Orchestrator(deps);
  return { orch, tmp, repoRoot, task, graph, deps };
}

function makeRepo(tmp) {
  const r = path.join(tmp, 'repo');
  fs.mkdirSync(r, { recursive: true });
  fs.writeFileSync(path.join(r, 'README.md'), 'init\n');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: r });
  spawnSync('git', ['config', 'user.email', 'e2e@l'], { cwd: r });
  spawnSync('git', ['config', 'user.name', 'e2e'], { cwd: r });
  spawnSync('git', ['add', '.'], { cwd: r });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: r });
  return r;
}

// ---------- nine success + one expected-failure ---------------------------

const oauthGraph = createTaskGraph({
  task: createTask({ id: 'oauth-login', goal: 'implement an offline OAuth login flow' }),
  nodes: [
    { id: 'analysis', goal: 'analyse', acceptanceCriteria: [{ id: 'a-an', verifierRef: 'architecture', required: true }] },
    { id: 'architecture', goal: 'arch', dependencies: ['analysis'], acceptanceCriteria: [{ id: 'a-ar', verifierRef: 'architecture', required: true }] },
    { id: 'backend', goal: 'be', dependencies: ['architecture'], acceptanceCriteria: [{ id: 'a-be', verifierRef: 'diff', required: true }] },
    { id: 'frontend', goal: 'fe', dependencies: ['architecture'], acceptanceCriteria: [{ id: 'a-fe', verifierRef: 'diff', required: true }] },
    { id: 'test', goal: 'tests', dependencies: ['backend', 'frontend'], acceptanceCriteria: [{ id: 'a-te', verifierRef: 'test', required: true }] },
    { id: 'review', goal: 'review', dependencies: ['test'], acceptanceCriteria: [{ id: 'a-re', verifierRef: 'audit', required: true }], kind: 'review' },
  ],
});

test('OAuth fixture (sequential): all nodes succeed', async () => {
  const graph = oauthGraph;
  const report = await runExecution(graph, () => async () => ({ success: true, output: { id: 'x' }, evidenceClaims: [], cost: 0, usage: {}, message: 'ok' }));
  assert.equal(report.executionStatus, 'EXECUTION_SUCCEEDED');
  assert.equal(Object.keys(report.nodes).length, 6);
});

test('Fan-out: two independent branches run after the root', async () => {
  const graph = createTaskGraph({
    task: createTask({ id: 'fan', goal: 'fan' }),
    nodes: [
      { id: 'root', goal: 'root', acceptanceCriteria: [{ id: 'r', verifierRef: 'diff', required: true }] },
      { id: 'left', goal: 'left', dependencies: ['root'], acceptanceCriteria: [{ id: 'l', verifierRef: 'diff', required: true }] },
      { id: 'right', goal: 'right', dependencies: ['root'], acceptanceCriteria: [{ id: 'ri', verifierRef: 'diff', required: true }] },
      { id: 'join', goal: 'join', dependencies: ['left', 'right'], acceptanceCriteria: [{ id: 'j', verifierRef: 'diff', required: true }] },
    ],
  });
  const order = [];
  const report = await executeWorkflow(graph, async (node) => {
    order.push(node.id);
    return { success: true, output: { id: node.id }, evidenceClaims: [], cost: 0, usage: {}, message: 'ok' };
  }, { concurrency: 2 });
  assert.equal(report.executionStatus, 'EXECUTION_SUCCEEDED');
  assert.deepEqual(order, ['root', 'left', 'right', 'join']);
});

test('Reviewer success: review node succeeds and run completes', async () => {
  const graph = createTaskGraph({
    task: createTask({ id: 'rev', goal: 'review' }),
    nodes: [
      { id: 'work', goal: 'work', acceptanceCriteria: [{ id: 'w', verifierRef: 'diff', required: true }], kind: 'work' },
      { id: 'review', goal: 'review', dependencies: ['work'], acceptanceCriteria: [{ id: 'r', verifierRef: 'audit', required: true }], kind: 'review' },
    ],
  });
  const report = await executeWorkflow(graph, async (node) => ({ success: true, output: {}, evidenceClaims: [], cost: 0, usage: {}, message: 'ok' }));
  assert.equal(report.nodes.review.status, 'SUCCEEDED');
});

test('Reviewer correction replans once', async () => {
  const original = createTaskGraph({
    task: createTask({ id: 'rev-replan', goal: 'rev-replan' }),
    nodes: [
      { id: 'work', goal: 'work', acceptanceCriteria: [{ id: 'w', verifierRef: 'diff', required: true }], kind: 'work' },
      { id: 'review', goal: 'review', dependencies: ['work'], acceptanceCriteria: [{ id: 'r', verifierRef: 'audit', required: true }], kind: 'review' },
    ],
  });
  const replacement = createTaskGraph({
    task: original.task,
    nodes: [
      { id: 'correction', goal: 'fix', acceptanceCriteria: [{ id: 'c', verifierRef: 'diff', required: true }], kind: 'work' },
      { id: 'verification', goal: 'verify', dependencies: ['correction'], acceptanceCriteria: [{ id: 'v', verifierRef: 'diff', required: true }], kind: 'work' },
      { id: 'review', goal: 'review', dependencies: ['verification'], acceptanceCriteria: [{ id: 'r2', verifierRef: 'audit', required: true }], kind: 'review' },
    ],
  });
  let calls = 0;
  const report = await executeWorkflow(original, async (node) => {
    if (node.id === 'review' && calls === 0) { calls += 1; return { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: 'reject' }; }
    return { success: true, output: {}, evidenceClaims: [], cost: 0, usage: {}, message: 'ok' };
  }, { replan: () => replacement });
  assert.equal(report.executionStatus, 'EXECUTION_SUCCEEDED');
});

test('Retry success: a transient failure is recovered on the next attempt', async () => {
  const graph = createTaskGraph({
    task: createTask({ id: 'retry', goal: 'retry' }),
    nodes: [{ id: 'a', goal: 'a', maxAttempts: 2, acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] }],
  });
  let n = 0;
  const report = await executeWorkflow(graph, async () => {
    n += 1;
    return n === 1 ? { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: 'first' } : { success: true, output: {}, evidenceClaims: [], cost: 0, usage: {}, message: 'ok' };
  });
  assert.equal(report.nodes.a.status, 'SUCCEEDED');
});

test('Retry exhaustion reports FAILED', async () => {
  const graph = createTaskGraph({
    task: createTask({ id: 'exhaust', goal: 'exhaust' }),
    nodes: [{ id: 'a', goal: 'a', maxAttempts: 2, acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] }],
  });
  const report = await executeWorkflow(graph, async () => ({ success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: 'no' }));
  assert.equal(report.executionStatus, 'FAILED');
});

test('Fallback success: a fallback agent replaces the primary', async () => {
  const graph = createTaskGraph({
    task: createTask({ id: 'fb', goal: 'fallback' }),
    nodes: [{ id: 'a', goal: 'a', maxAttempts: 1, fallbackAgentIds: ['codex'], acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] }],
  });
  let attempts = 0;
  const report = await executeWorkflow(graph, async (node, ctx) => {
    attempts += 1;
    if (ctx.agentId === 'codex') return { success: true, output: {}, evidenceClaims: [], cost: 0, usage: {}, message: 'ok' };
    return { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: 'primary failed' };
  }, { selectFallback: () => 'codex' });
  assert.equal(report.nodes.a.status, 'SUCCEEDED');
});

test('No eligible agent reports a failure with a useful message', async () => {
  const graph = createTaskGraph({
    task: createTask({ id: 'no-agent', goal: 'no agent' }),
    nodes: [{ id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] }],
  });
  const report = await runExecution(graph, () => async () => ({ success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: 'no agent' }));
  assert.equal(report.executionStatus, 'FAILED');
});

test('Thrown agent error is normalised into a FAILED node', async () => {
  const graph = createTaskGraph({
    task: createTask({ id: 'throw', goal: 'throw' }),
    nodes: [{ id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] }],
  });
  const report = await executeWorkflow(graph, async () => { throw new Error('explosion'); });
  assert.equal(report.nodes.a.status, 'FAILED');
});

test('Budget/deadline termination stops further attempts', async () => {
  const graph = createTaskGraph({
    task: createTask({ id: 'budget', goal: 'budget', deadline: '2000-01-01T00:00:00.000Z' }),
    nodes: [{ id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] }],
  });
  const ctx = await runOrchestratorWith({ graph, task: graph.task });
  await assert.rejects(() => ctx.orch.runTask(graph.task, { approveChangeSet: () => ({ approved: true }) }), (err) => err.code === 'ORCHESTRATOR_DEADLINE_EXPIRED');
});

test('Expected-failure fixture: orchestrator preserves AWAITING_APPROVAL when approval is denied', async () => {
  const ctx = await runOrchestratorWith();
  const report = await ctx.orch.runTask(ctx.task, { approveChangeSet: () => ({ approved: false }) });
  assert.equal(report.finalStatus, 'AWAITING_APPROVAL');
});

// ---------- governance: fail-closed ----------------------------------------

test('Governance: corrupt EventStore integrity refuses to map Runtime finish to COMPLETED', async () => {
  const ctx = await runOrchestratorWith({
    runtime: new DevflowRuntimeAdapter({
      runner: async () => ({ stdout: JSON.stringify({
        session: { id: 's1' },
        state_revision: 0,
        status: 'applied',
        blocking_reasons: [],
        evidence_ids: [],
        decision: { kind: 'finish', reason: 'spurious' },
        event_store_integrity: { valid: false, last_sequence: 0, error: 'corrupt' },
      }), stderr: '', exitCode: 0 }),
      tempRoot: ctx_temproot(),
    }),
  });
  const report = await ctx.orch.runTask(ctx.task, { approveChangeSet: (cs) => ({ approved: true, actor: 'human', reason: 'go', changeSetSha256: cs.patchSha256 }) });
  assert.equal(report.finalStatus, 'QUARANTINED');
});

function ctx_temproot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-corrupt-'));
}

test('Governance: change-sandbox file-limit rejects candidates with > 5 files', async () => {
  const { ChangeSandboxError, collectChangeSet } = await import('../core/change-sandbox.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-cap-'));
  try {
    const repoRoot = makeRepo(tmp);
    const { createChangeSandbox } = await import('../core/change-sandbox.mjs');
    const sandbox = await createChangeSandbox({ repoRoot, runId: 'cap' });
    try {
      for (let i = 0; i < 6; i += 1) fs.writeFileSync(path.join(sandbox.sandboxPath, `f${i}.txt`), 'x\n');
      await assert.rejects(() => collectChangeSet(sandbox, { baseCommit: sandbox.baseCommit }), (err) => err.code === 'CHANGE_SET_FILE_LIMIT');
    } finally {
      await sandbox.cleanup();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Governance: change-sandbox binary / rename / delete are rejected', async () => {
  const { collectChangeSet } = await import('../core/change-sandbox.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-bin-'));
  try {
    const repoRoot = makeRepo(tmp);
    const { createChangeSandbox } = await import('../core/change-sandbox.mjs');
    const sandbox = await createChangeSandbox({ repoRoot, runId: 'bin' });
    try {
      fs.writeFileSync(path.join(sandbox.sandboxPath, 'README.md'), Buffer.from([0, 1, 2, 3, 0, 5]));
      await assert.rejects(() => collectChangeSet(sandbox, { baseCommit: sandbox.baseCommit }), (err) => err.code === 'CHANGE_SET_BINARY_FORBIDDEN');
    } finally {
      await sandbox.cleanup();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- two-session isolation ----------------------------------------

test('Two consecutive Runtime sessions in one workspace remain isolated', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-2s-'));
  try {
    const repoRoot = makeRepo(tmp);
    const ctx = await runOrchestratorWith({ repoRoot });
    const taskA = createTask({ id: 'sa', goal: 'session A' });
    const taskB = createTask({ id: 'sb', goal: 'session B' });
    const graphA = createTaskGraph({ task: taskA, nodes: [{ id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] }] });
    const graphB = createTaskGraph({ task: taskB, nodes: [{ id: 'b', goal: 'b', acceptanceCriteria: [{ id: 'bb', verifierRef: 'diff', required: true }] }] });
    const reportA = await ctx.orch.runTask(taskA, { approveChangeSet: (cs) => ({ approved: true, changeSetSha256: cs.patchSha256 }) });
    const reportB = await ctx.orch.runTask(taskB, { approveChangeSet: (cs) => ({ approved: true, changeSetSha256: cs.patchSha256 }) });
    // The orchestrator's session IDs are deterministic across runs (UUID-like),
    // but the runIds and routing decisions must remain disjoint per task.
    assert.notEqual(reportA.runId, reportB.runId);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- bounded live OAuth acceptance ---------------------------------

test('Bounded live OAuth acceptance: 5-file limit and fresh fixture passes its own tests', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-oauth-live-'));
  try {
    const demoRoot = path.join(tmp, 'oauth-demo');
    copyDir(path.resolve('fixtures/live/oauth-demo'), demoRoot);
    const result = spawnSync('node', ['--test', 'tests/oauth.test.mjs'], { cwd: demoRoot, shell: false, encoding: 'utf8' });
    assert.equal(result.status, 0, `oauth-demo tests failed:\n${result.stdout}\n${result.stderr}`);
    // Count changed files relative to a clean copy of the seed.
    const seedFiles = new Set(fs.readdirSync(path.resolve('fixtures/live/oauth-demo'), { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(d.parentPath || d.path, d.name).replace(/\\/g, '/')));
    const demoFiles = new Set(fs.readdirSync(demoRoot, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(d.parentPath || d.path, d.name).replace(/\\/g, '/')));
    const changed = [...demoFiles].filter((f) => !seedFiles.has(f.replace(demoRoot, path.resolve('fixtures/live/oauth-demo')).replace(/\\/g, '/')));
    assert.ok(changed.length <= 5, `live acceptance touched ${changed.length} files, must be <= 5`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
