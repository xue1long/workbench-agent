// Level 3 Task 4: pipeline runner — artifact persistence, stage-state
// recording, fail-closed gate, and resume without duplicated side effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { StateStore } from '../core/store.mjs';
import { Orchestrator } from '../core/orchestrator.mjs';
import { DevflowRuntimeAdapter } from '../adapters/devflow-runtime.mjs';
import { createPipelineRunner } from '../core/pipeline-runner.mjs';
import { standardDevelopmentPipeline } from '../core/pipeline-templates.mjs';

function makeRepo(tmp) {
  const r = path.join(tmp, 'repo');
  fs.mkdirSync(r, { recursive: true });
  fs.writeFileSync(path.join(r, 'README.md'), 'init\n', 'utf8');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: r });
  spawnSync('git', ['config', 'user.email', 'l3@local'], { cwd: r });
  spawnSync('git', ['config', 'user.name', 'l3'], { cwd: r });
  spawnSync('git', ['add', '.'], { cwd: r });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: r });
  return r;
}

const STAGE_OUTPUTS = {
  requirement: 'requirement-notes',
  analysis: 'analysis',
  plan: 'plan',
  implementation: 'implementation-artifact',
  test: 'test-report',
  review: 'review-decision',
};

function makeEnv(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l3-'));
  const repoRoot = overrides.repoRoot ?? makeRepo(tmp);
  const store = StateStore.open('ws-l3', { root: path.join(tmp, 'store') });
  const artifactsRoot = path.join(tmp, 'artifacts');
  const invocations = {};
  const runtimeCalls = [];
  const invoker = overrides.invoker ?? (async (agent, node) => {
    invocations[node.id] = (invocations[node.id] ?? 0) + 1;
    if (overrides.failStages?.includes(node.id)) {
      return { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: `${node.id} failed` };
    }
    const name = STAGE_OUTPUTS[node.id] ?? `${node.id}-output.md`;
    const content = overrides.contentFor ? overrides.contentFor(node) : `# ${node.id} for ${node.goal}\n`;
    return {
      success: true,
      evidenceClaims: [{ kind: 'artifact', payload: { ref: node.id } }],
      output: { artifacts: [{ name, content, kind: 'markdown' }] },
      cost: 1,
      usage: {},
      message: 'ok',
    };
  });
  const runtime = new DevflowRuntimeAdapter({
    runner: async (args) => {
      runtimeCalls.push(args.join(' '));
      return {
        stdout: JSON.stringify({
          session: { id: 's-l3', intent_version: '1.0.0', policy_version: '1.0.0', state_revision: 1, status: 'active' },
          state_revision: 1,
          status: 'applied',
          blocking_reasons: [],
          evidence_ids: ['ev-l3'],
          decision: { kind: 'finish', reason: 'all required acceptances verified' },
          event_store_integrity: { valid: true, last_sequence: 5, error: null },
        }),
        stderr: '',
        exitCode: 0,
      };
    },
    tempRoot: tmp,
  });
  const changeSandbox = {
    create: async () => ({ repoRoot, sandboxPath: repoRoot, runId: 'r', baseCommit: 'h', async cleanup() {} }),
    collect: async () => ({
      runId: 'r', baseCommit: 'h', patchSha256: 'a'.repeat(64),
      changedFiles: ['README.md'],
      edits: [{ path: 'README.md', content: 'init\n', expectedDigest: '', changeType: 'replace' }],
      sandboxPath: repoRoot,
    }),
  };
  const agents = {
    list: () => [{
      id: 'fixture',
      capabilities: ['requirement', 'analysis', 'planning', 'implementation', 'testing', 'reviewer'],
      tools: [], maxRisk: 'high', maxContextTokens: 32000,
    }],
  };
  const orchestrator = new Orchestrator({
    repoRoot,
    planner: { plan: async () => { throw new Error('pipeline runner must not plan'); } },
    invoker: { invoke: invoker },
    changeSandbox,
    runtime,
    agents,
    audit: overrides.audit ?? { agentSelected: () => {}, toolCalled: () => {}, runtimeDecided: () => {} },
  });
  const runner = createPipelineRunner({ orchestrator, store, artifactsRoot });
  const approveAll = (cs) => ({ approved: true, actor: 'human', reason: 'go', changeSetSha256: cs.patchSha256 });
  return { tmp, repoRoot, store, artifactsRoot, runner, invocations, runtimeCalls, approveAll, invoker };
}

const task = (goal) => ({ id: 'p-task', goal });

test('artifacts persist to disk with metadata rows; content never enters JSONL', async () => {
  const env = makeEnv();
  try {
    const report = await env.runner.run({ template: standardDevelopmentPipeline(), task: task('Add OAuth login'), approveChangeSet: env.approveAll });
    assert.equal(report.finalStatus, 'COMPLETED');
    assert.equal(report.executionStatus, 'EXECUTION_SUCCEEDED');
    // Content is on disk under artifactsRoot/<pipelineId>/<stageId>/<name>.
    const file = path.join(env.artifactsRoot, 'standard-development', 'requirement', 'requirement-notes');
    assert.ok(fs.existsSync(file), 'artifact file must exist on disk');
    assert.match(fs.readFileSync(file, 'utf8'), /Requirement: Add OAuth login/);
    // Metadata rows carry path/hash/bytes but never content.
    const rows = env.store.readRows('pipeline_artifact');
    assert.equal(rows.length, 6, 'one artifact row per stage');
    for (const row of rows) {
      assert.equal(typeof row.content, 'undefined', 'artifact rows must not carry content');
      assert.equal(typeof row.contentHash, 'string');
      assert.equal(typeof row.byteCount, 'number');
      assert.equal(typeof row.filePath, 'string');
      assert.ok('supersedes' in row);
    }
    const raw = fs.readFileSync(path.join(env.tmp, 'store', 'ws-l3', 'pipeline_artifact.jsonl'), 'utf8');
    assert.ok(!raw.includes('Requirement: Add OAuth login'), 'artifact content must not appear in JSONL rows');
    assert.equal(report.artifacts.length, 6);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('report links stages, artifacts, changed files and review evidence', async () => {
  const env = makeEnv();
  try {
    const report = await env.runner.run({ template: standardDevelopmentPipeline(), task: task('Add OAuth login'), approveChangeSet: env.approveAll });
    assert.deepEqual(Object.keys(report.stages), ['requirement', 'analysis', 'plan', 'implementation', 'test', 'review']);
    for (const stage of Object.values(report.stages)) assert.equal(stage.status, 'SUCCEEDED');
    assert.deepEqual(report.changedFiles, ['README.md']);
    assert.ok(report.stages.review.evidenceClaims.length >= 1);
    assert.equal(report.reviewDecision.status, 'SUCCEEDED');
    assert.equal(report.templateVersion, '1.0.0');
    assert.equal(report.routing.requirement.agentId, 'fixture');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('resume reuses verified stages without re-invoking agents or duplicating side effects', async () => {
  const env = makeEnv();
  try {
    const run1 = await env.runner.run({ template: standardDevelopmentPipeline(), task: task('Add OAuth login'), approveChangeSet: env.approveAll });
    assert.equal(run1.finalStatus, 'COMPLETED');
    const after1 = { ...env.invocations };
    const run2 = await env.runner.run({ template: standardDevelopmentPipeline(), task: task('Add OAuth login'), approveChangeSet: env.approveAll, resumeRunId: run1.runId });
    assert.equal(run2.resumedFrom, run1.runId);
    assert.equal(run2.finalStatus, 'COMPLETED');
    // No stage was re-invoked: the second run reused every verified stage.
    assert.deepEqual(env.invocations, after1, 'verified stages must not be re-invoked on resume');
    assert.ok(run2.stages.requirement.status === 'SUCCEEDED');
    // Reused artifacts are not re-persisted as new content rows.
    const rowsForRun2 = env.store.readRows('pipeline_artifact').filter((r) => r.runId === run2.runId);
    assert.equal(rowsForRun2.length, 0, 'reused stages must not write new artifact rows');
    // The artifact file was not overwritten.
    const file = path.join(env.artifactsRoot, 'standard-development', 'requirement', 'requirement-notes');
    assert.match(fs.readFileSync(file, 'utf8'), /Requirement: Add OAuth login/);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('resume re-runs a stage whose artifact file was edited on disk despite matching definitionHash', async () => {
  const env = makeEnv();
  try {
    const run1 = await env.runner.run({ template: standardDevelopmentPipeline(), task: task('Add OAuth login'), approveChangeSet: env.approveAll });
    assert.equal(run1.finalStatus, 'COMPLETED');
    const after1 = { ...env.invocations };
    // Simulate an out-of-band edit of the implementation artifact: the file
    // on disk no longer matches the recorded sha256, so resume must re-run.
    const implFile = path.join(env.artifactsRoot, 'standard-development', 'implementation', 'implementation-artifact');
    fs.writeFileSync(implFile, '# tampered\n', 'utf8');
    const run2 = await env.runner.run({ template: standardDevelopmentPipeline(), task: task('Add OAuth login'), approveChangeSet: env.approveAll, resumeRunId: run1.runId });
    assert.equal(run2.finalStatus, 'COMPLETED');
    // Only the tampered stage re-runs; unchanged stages stay reused.
    assert.equal(env.invocations.implementation, after1.implementation + 1, 'edited artifact stage re-runs');
    assert.equal(env.invocations.requirement, after1.requirement, 'unchanged stages must stay reused');
    // The re-run restored the artifact from the recorded output, replacing the tampered bytes.
    assert.notEqual(fs.readFileSync(implFile, 'utf8'), '# tampered\n', 'tampered content must be replaced');
    assert.equal(run2.stages.implementation.artifactHashes['implementation-artifact'], run1.stages.implementation.artifactHashes['implementation-artifact'], 'deterministic re-run reproduces the same artifact hash');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('interrupted run fails closed without a Runtime call and resumes from the failed stage', async () => {
  const myInvocations = {};
  let phase = 1;
  const env = makeEnv({
    invoker: async (agent, node) => {
      myInvocations[node.id] = (myInvocations[node.id] ?? 0) + 1;
      if (phase === 1 && node.id === 'implementation') {
        return { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: 'impl failed' };
      }
      return {
        success: true,
        evidenceClaims: [{ kind: 'artifact', payload: { ref: node.id } }],
        output: { artifacts: [{ name: STAGE_OUTPUTS[node.id], content: `# ${node.id} for ${node.goal}\n`, kind: 'markdown' }] },
        cost: 1,
        usage: {},
        message: 'ok',
      };
    },
  });
  try {
    const run1 = await env.runner.run({ template: standardDevelopmentPipeline(), task: task('Add OAuth login'), approveChangeSet: env.approveAll });
    assert.equal(run1.executionStatus, 'FAILED');
    assert.equal(run1.finalStatus, 'FAILED');
    assert.equal(run1.actionStatus, 'stage_failed');
    assert.equal(env.runtimeCalls.length, 0, 'no Runtime action may be submitted after a failed stage');
    assert.equal(run1.stages.implementation.status, 'FAILED');
    assert.equal(run1.stages.review.status, 'BLOCKED');
    // Resume: implementation is retried, everything before it is reused.
    const invocationsAfterRun1 = { ...myInvocations };
    phase = 2;
    const run2 = await env.runner.run({ template: standardDevelopmentPipeline(), task: task('Add OAuth login'), approveChangeSet: env.approveAll, resumeRunId: run1.runId });
    assert.equal(run2.executionStatus, 'EXECUTION_SUCCEEDED');
    assert.equal(run2.finalStatus, 'COMPLETED');
    assert.equal(myInvocations.requirement, invocationsAfterRun1.requirement, 'requirement stage reused');
    assert.equal(myInvocations.implementation, invocationsAfterRun1.implementation + 1, 'implementation re-runs');
    assert.equal(myInvocations.test, 1, 'blocked test stage re-runs once');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('status returns recorded stage states for a run', async () => {
  const env = makeEnv();
  try {
    const run1 = await env.runner.run({ template: standardDevelopmentPipeline(), task: task('Add OAuth login'), approveChangeSet: env.approveAll });
    const status = await env.runner.status({ pipelineId: 'standard-development', runId: run1.runId });
    assert.equal(Object.keys(status.stages).length, 6);
    assert.equal(status.stages.review.status, 'SUCCEEDED');
    assert.ok(status.stages.requirement.artifactHashes['requirement-notes']);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
