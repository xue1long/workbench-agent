// Level 2 Task 10: orchestrator service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { createTask, createTaskGraph } from '../core/task-graph.mjs';
import { Orchestrator, OrchestratorError } from '../core/orchestrator.mjs';
import { DevflowRuntimeAdapter } from '../adapters/devflow-runtime.mjs';

function makeRepo(tmp) {
  const repoRoot = path.join(tmp, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'init\n', 'utf8');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.email', 'orch@local'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.name', 'orch'], { cwd: repoRoot });
  spawnSync('git', ['add', '.'], { cwd: repoRoot });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });
  return repoRoot;
}

function makeTask() {
  return createTask({ id: 'oauth', goal: 'implement oauth login' });
}

function makeGraph() {
  return createTaskGraph({
    task: makeTask(),
    nodes: [
      { id: 'design', goal: 'design oauth', acceptanceCriteria: [{ id: 'd1', verifierRef: 'architecture', required: true }] },
      { id: 'implement', goal: 'implement', dependencies: ['design'], acceptanceCriteria: [{ id: 'i1', verifierRef: 'diff', required: true }] },
    ],
  });
}

function makeDeps(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-orch-'));
  const repoRoot = overrides.repoRoot ?? makeRepo(tmp);
  const graph = makeGraph();
  const planner = {
    plan: async () => graph,
  };
  const invoker = {
    invoke: async (agent, node) => ({
      success: true,
      evidenceClaims: [{ kind: 'diff', payload: { ref: node.id } }],
      output: { id: node.id },
      cost: 0,
      usage: {},
      message: '',
    }),
  };
  const changeSandbox = {
    create: async () => ({
      repoRoot,
      sandboxPath: repoRoot,
      runId: 'r',
      baseCommit: 'h',
      async cleanup() {},
    }),
    collect: async () => ({
      runId: 'r',
      baseCommit: 'h',
      patchSha256: 'a'.repeat(64),
      changedFiles: ['README.md'],
      edits: [{ path: 'README.md', content: 'init\n', expectedDigest: '', changeType: 'replace' }],
      sandboxPath: repoRoot,
    }),
  };
  const runtime = overrides.runtime ?? new DevflowRuntimeAdapter({
    runner: async () => ({
      stdout: JSON.stringify({
        session: { id: 's1', intent_version: '1.0.0', policy_version: '1.0.0', state_revision: 1, status: 'active' },
        state_revision: 1,
        status: 'applied',
        blocking_reasons: [],
        evidence_ids: ['ev-runtime'],
        decision: { kind: 'finish', reason: 'all required acceptances verified' },
        event_store_integrity: { valid: true, last_sequence: 5, error: null },
      }),
      stderr: '',
      exitCode: 0,
    }),
    tempRoot: tmp,
  });
  const agents = {
    list: () => [
      { id: 'fixture', capabilities: ['coding'], tools: [], maxRisk: 'low', maxContextTokens: 32000 },
    ],
  };
  const audit = overrides.audit ?? { events: [], toolCalled: () => {}, runtimeDecided: () => {}, agentSelected: () => {} };
  return { repoRoot, tmp, planner, invoker, changeSandbox, runtime, agents, audit };
}

test('Orchestrator without approval preserves the candidate patch and skips Runtime', async () => {
  const deps = makeDeps();
  const orch = new Orchestrator(deps);
  const report = await orch.runTask(makeTask(), { approveChangeSet: () => ({ approved: false }) });
  assert.equal(report.finalStatus, 'AWAITING_APPROVAL');
  assert.equal(report.executionStatus, 'EXECUTION_SUCCEEDED');
});

test('Orchestrator with approval maps valid Runtime finish to COMPLETED', async () => {
  const deps = makeDeps();
  const orch = new Orchestrator(deps);
  const report = await orch.runTask(makeTask(), { approveChangeSet: (cs) => ({ approved: true, actor: 'human', reason: 'go', changeSetSha256: cs.patchSha256 }) });
  assert.equal(report.finalStatus, 'COMPLETED');
  assert.equal(report.decision.kind, 'finish');
  assert.equal(report.eventStoreIntegrity.valid, true);
  assert.ok(report.trustedEvidenceIds.length > 0);
});

test('Orchestrator maps invalid Runtime integrity to QUARANTINED', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-orch-corrupt-'));
  const deps = makeDeps({
    runtime: new DevflowRuntimeAdapter({
      runner: async () => ({
        stdout: JSON.stringify({
          session: { id: 's1' },
          state_revision: 0,
          status: 'applied',
          blocking_reasons: [],
          evidence_ids: [],
          decision: { kind: 'finish', reason: 'spurious' },
          event_store_integrity: { valid: false, last_sequence: 0, error: 'corrupt' },
        }),
        stderr: '',
        exitCode: 0,
      }),
      tempRoot: tmp,
    }),
  });
  const orch = new Orchestrator(deps);
  const report = await orch.runTask(makeTask(), { approveChangeSet: (cs) => ({ approved: true, actor: 'human', reason: 'go', changeSetSha256: cs.patchSha256 }) });
  assert.equal(report.finalStatus, 'QUARANTINED');
  // The Runtime reported finish but EventStore integrity is invalid; the
  // orchestrator's finalStatus must refuse to map that to COMPLETED.
  assert.notEqual(report.finalStatus, 'COMPLETED');
});

test('Orchestrator enforces deadline cancellation', async () => {
  const deps = makeDeps();
  const orch = new Orchestrator(deps);
  const t = createTask({ id: 'late', goal: 'late task', deadline: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(
    () => orch.runTask(t, { approveChangeSet: () => ({ approved: true, actor: 'human', reason: 'go' }) }),
    (err) => err instanceof OrchestratorError && err.code === 'ORCHESTRATOR_DEADLINE_EXPIRED',
  );
});

test('Orchestrator.runTask rejects when dependencies are missing', () => {
  assert.throws(
    () => new Orchestrator({}),
    (err) => err instanceof OrchestratorError && err.code === 'ORCHESTRATOR_DEPS_INVALID',
  );
});
