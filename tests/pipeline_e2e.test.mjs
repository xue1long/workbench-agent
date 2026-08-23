// Level 3 Task 11: Level 3 acceptance fixtures and phase gate.
//
// Five repository tasks finish through the standard pipeline against REAL
// temporary Git repositories with the REAL change-sandbox (git worktree +
// collectChangeSet); the Runtime is a stub returning valid `finish`, so the
// governed path is exercised end-to-end without a live agent. The oauth-demo
// fixture provides a real repository whose own tests are run by the Test
// stage. Interrupted execution resumes without duplicating side effects; the
// retrieval benchmark reports precision@5 and source coverage; scope leaks
// are impossible.

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
import { createChangeSandbox, collectChangeSet } from '../core/change-sandbox.mjs';
import { createKnowledgeStore } from '../core/knowledge-store.mjs';
import { retrieve } from '../core/knowledge-retrieval.mjs';

const STAGE_OUTPUTS = {
  requirement: 'requirement-notes',
  analysis: 'analysis',
  plan: 'plan',
  implementation: 'implementation-artifact',
  test: 'test-report',
  review: 'review-decision',
};

function gitInit(root) {
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'l3@local'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'l3'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function makeEnv({ goal, seed = {}, implWriter = null, testRunner = null, invokeOverrides = null }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l3-e2e-'));
  const repoRoot = path.join(tmp, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  if (seed.files) {
    for (const [rel, content] of Object.entries(seed.files)) {
      const target = path.join(repoRoot, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  } else {
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  }
  gitInit(repoRoot);
  const store = StateStore.open('ws-l3', { root: path.join(tmp, 'store') });
  const artifactsRoot = path.join(tmp, 'artifacts');
  const invocations = {};
  const invoker = {
    invoke: async (agent, node, opts = {}) => {
      invocations[node.id] = (invocations[node.id] ?? 0) + 1;
      const sandboxPath = opts.sandboxPath ?? repoRoot;
      if (invokeOverrides?.[node.id]) return invokeOverrides[node.id](node, sandboxPath, opts);
      if (node.id === 'implementation') {
        const writer = implWriter ?? ((sp) => {
          fs.mkdirSync(path.join(sp, 'src'), { recursive: true });
          fs.writeFileSync(path.join(sp, `src/feature-${goal.replace(/\W+/g, '-')}.js`), `// implemented: ${goal}\nexport const done = true;\n`, 'utf8');
        });
        writer(sandboxPath);
      }
      if (node.id === 'test' && testRunner) {
        const output = testRunner(sandboxPath);
        if (!output.passed) {
          return { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: `tests failed: ${output.stdout?.slice(0, 200)}` };
        }
        return {
          success: true,
          evidenceClaims: [{ kind: 'test', payload: { ref: node.id, command: output.command, passed: true } }],
          output: { artifacts: [{ name: STAGE_OUTPUTS.test, content: output.stdout ?? 'ok', kind: 'test-report' }] },
          cost: 0,
          usage: {},
          message: 'tests passed',
        };
      }
      return {
        success: true,
        evidenceClaims: [{ kind: 'artifact', payload: { ref: node.id } }],
        output: { artifacts: [{ name: STAGE_OUTPUTS[node.id], content: `# ${node.id} for ${goal}\n`, kind: 'markdown' }] },
        cost: 0,
        usage: {},
        message: 'ok',
      };
    },
  };
  const runtime = new DevflowRuntimeAdapter({
    runner: async () => ({
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
    }),
    tempRoot: tmp,
  });
  const orchestrator = new Orchestrator({
    repoRoot,
    planner: { plan: async () => { throw new Error('e2e pipeline must not plan'); } },
    invoker,
    changeSandbox: { create: createChangeSandbox, collect: collectChangeSet },
    runtime,
    agents: {
      list: () => [{
        id: 'fixture',
        capabilities: ['requirement', 'analysis', 'planning', 'implementation', 'testing', 'reviewer'],
        tools: [], maxRisk: 'high', maxContextTokens: 32000,
      }],
    },
    audit: { agentSelected: () => {}, toolCalled: () => {}, runtimeDecided: () => {} },
  });
  const runner = createPipelineRunner({ orchestrator, store, artifactsRoot });
  const approveAll = (cs) => ({ approved: true, actor: 'e2e', reason: 'go', changeSetSha256: cs.patchSha256 });
  return { tmp, repoRoot, store, artifactsRoot, runner, orchestrator, invocations, approveAll, invoker };
}

const task = (goal) => ({ id: 'e2e-task', goal });

test('five real repository tasks finish through the standard pipeline', async () => {
  const goals = ['Add OAuth login', 'Add billing cycle', 'Add project sync', 'Add CLI commands', 'Add config validation'];
  for (const goal of goals) {
    const env = makeEnv({ goal });
    try {
      const report = await env.runner.run({ template: standardDevelopmentPipeline(), task: task(goal), approveChangeSet: env.approveAll });
      assert.equal(report.finalStatus, 'COMPLETED', `goal "${goal}" must complete`);
      assert.equal(report.executionStatus, 'EXECUTION_SUCCEEDED');
      for (const stage of Object.values(report.stages)) assert.equal(stage.status, 'SUCCEEDED');
      assert.equal(report.artifacts.length, 6);
      assert.ok(report.changedFiles.length >= 1, 'the implementation stage must produce real changed files');
    } finally {
      fs.rmSync(env.tmp, { recursive: true, force: true });
    }
  }
});

test('oauth-demo repository: result links requirements, changed files, test output and review evidence', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l3-oauth-'));
  try {
    const demoRoot = path.join(tmp, 'oauth-demo');
    copyDir(path.resolve('fixtures/live/oauth-demo'), demoRoot);
    const env = makeEnv({
      goal: 'Add OAuth login',
      seed: { files: { placeholder: 'x' } }, // repo is replaced below
      testRunner: (sandboxPath) => {
        const r = spawnSync('node', ['--test', 'tests/oauth.test.mjs'], { cwd: sandboxPath, encoding: 'utf8' });
        return { passed: r.status === 0, stdout: r.stdout, command: 'node --test tests/oauth.test.mjs' };
      },
    });
    fs.rmSync(env.repoRoot, { recursive: true, force: true });
    fs.mkdirSync(env.repoRoot, { recursive: true });
    copyDir(demoRoot, env.repoRoot);
    gitInit(env.repoRoot);
    const goal = 'Add OAuth login';
    const report = await env.runner.run({
      template: standardDevelopmentPipeline(),
      task: task(goal),
      approveChangeSet: env.approveAll,
    });
    assert.equal(report.finalStatus, 'COMPLETED');
    // Requirement stage links to the task goal through its artifact.
    assert.match(env.store.readRows('pipeline_artifact').find((r) => r.stageId === 'requirement').contentHash, /^[a-f0-9]{64}$/);
    // Changed files are the real sandbox diff (implementation wrote a new file).
    assert.ok(report.changedFiles.length >= 1, `changedFiles=${report.changedFiles.join(',')}`);
    // Test stage output: the fixture's own test suite ran in the sandbox.
    const testStage = report.stages.test;
    assert.ok(testStage.evidenceClaims.some((c) => c.kind === 'test'), 'test evidence must be linked');
    assert.equal(report.stages.test.artifactHashes['test-report'] != null, true, 'test report artifact persisted');
    // Review evidence and decision.
    assert.equal(report.reviewDecision.status, 'SUCCEEDED');
    assert.ok(report.stages.review.evidenceClaims.length >= 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('interrupted execution resumes without duplicating completed side effects (real repo)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l3-resume-'));
  try {
    let phase = 1;
    let implWrites = 0;
    const env = makeEnv({
      goal: 'Add OAuth login',
      invokeOverrides: {
        implementation: async (node, sandboxPath, opts) => {
          if (phase === 1) {
            return { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: 'interrupted' };
          }
          fs.mkdirSync(path.join(sandboxPath, 'src'), { recursive: true });
          fs.writeFileSync(path.join(sandboxPath, 'src/oauth.js'), `// oauth impl attempt ${implWrites + 1}\n`, 'utf8');
          implWrites += 1;
          return { success: true, evidenceClaims: [{ kind: 'diff', payload: { ref: node.id } }], output: { artifacts: [{ name: 'implementation-artifact', content: '# impl\n', kind: 'md' }] }, cost: 0, usage: {}, message: 'ok' };
        },
      },
    });
    const run1 = await env.runner.run({ template: standardDevelopmentPipeline(), task: task('Add OAuth login'), approveChangeSet: env.approveAll });
    assert.equal(run1.finalStatus, 'FAILED');
    assert.equal(run1.stages.implementation.status, 'FAILED');
    phase = 2;
    const run2 = await env.runner.run({ template: standardDevelopmentPipeline(), task: task('Add OAuth login'), approveChangeSet: env.approveAll, resumeRunId: run1.runId });
    assert.equal(run2.finalStatus, 'COMPLETED');
    // The real file was written exactly once (only on the resumed attempt);
    // the first run never wrote it.
    assert.equal(implWrites, 1, 'completed side effects must not be duplicated');
    assert.equal(env.invocations.requirement, 1, 'verified stages reused');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('retrieval benchmark reports precision@5 and source coverage; scope never leaks', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l3-bench-'));
  try {
    const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
    const k = createKnowledgeStore({ store, objectsRoot: path.join(tmp, 'objects') });
    k.ingestDirectory({ dir: path.resolve('fixtures/knowledge/benchmark/documents'), scope: '.' });
    const rows = k.list();
    const index = rows.map((row) => ({ ...row, scope: `${row.sourcePath.split('/')[0]}/`, content: k.content(row) }));
    const benchmark = JSON.parse(fs.readFileSync(path.resolve('fixtures/knowledge/benchmark/queries.json'), 'utf8'));
    const { runRetrievalBenchmark } = await import('../core/retrieval-benchmark.mjs');
    const result = runRetrievalBenchmark({ index, benchmark });
    assert.ok(result.precisionAt5 > 0, 'precision@5 must be reported');
    assert.ok(result.sourceCoverage > 0, 'source coverage must be reported');
    // Hard scope boundary at the e2e level: a src/-scoped query returns only src/ items.
    const res = retrieve({ index, query: 'oauth provider', scope: 'src/', budgetChars: 100000 });
    assert.ok(res.items.length > 0);
    for (const item of res.items) assert.ok(item.sourcePath.startsWith('src/'), `scope leak: ${item.sourcePath}`);
    assert.equal(res.scopeCapped >= 0, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
