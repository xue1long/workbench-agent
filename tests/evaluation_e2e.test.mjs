// Level 4 Task 7: Level 4 acceptance fixtures and phase gate.
//
// Deterministic re-evaluation, LLM-judge separation, the 50-case frozen
// baseline with the success/cost/latency/failure answers, and the redacted
// benchmark exchange round-trip.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore } from '../core/store.mjs';
import { evaluate } from '../core/evaluation.mjs';
import { ruleEvaluator, testEvaluator, llmJudgeEvaluator, combineEvaluations } from '../core/evaluators.mjs';
import { taskCaseCatalog, freezeBaseline } from '../core/benchmark-suites.mjs';
import { queryTrajectory, trajectorySummary, persistTrajectory } from '../core/trajectory.mjs';
import { exportBenchmarkRun, importBenchmarkRun } from '../core/benchmark-exchange.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l4-e2e-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  return { tmp, store };
}

function makeRunCase() {
  return (taskCase) => {
    const outcome = taskCase.outcome;
    let finalStatus = 'COMPLETED';
    let executionStatus = 'EXECUTION_SUCCEEDED';
    let actionStatus = 'applied';
    let decision = { kind: 'finish' };
    let evidenceClaims = [];
    if (outcome === 'test-fail') {
      finalStatus = 'FAILED'; executionStatus = 'EXECUTION_SUCCEEDED'; actionStatus = 'no_candidates';
      decision = { kind: 'halt', reason: 'tests failed' };
      evidenceClaims = [{ kind: 'test', passed: false, sourcePath: 'tests/x.test.mjs' }];
    } else if (outcome === 'stage-fail' || outcome === 'blocked') {
      finalStatus = 'FAILED'; executionStatus = 'FAILED'; actionStatus = 'stage_failed';
      decision = { kind: 'halt', reason: 'stage failed' };
    } else if (outcome === 'budget') {
      finalStatus = 'FAILED'; executionStatus = 'FAILED'; actionStatus = 'stage_failed';
      decision = { kind: 'halt', reason: 'task budget exhausted' };
    } else if (outcome === 'deadline') {
      finalStatus = 'FAILED'; executionStatus = 'FAILED'; actionStatus = 'stage_failed';
      decision = { kind: 'halt', reason: 'deadline passed' };
    } else if (outcome === 'no-candidate') {
      finalStatus = 'FAILED'; executionStatus = 'EXECUTION_SUCCEEDED'; actionStatus = 'no_candidates';
      decision = { kind: 'halt', reason: 'no successful nodes produced candidates' };
    } else if (outcome === 'approval') {
      finalStatus = 'AWAITING_APPROVAL'; executionStatus = 'EXECUTION_SUCCEEDED'; actionStatus = 'awaiting_approval';
      decision = { kind: 'continue', reason: 'awaiting human approval' };
    } else if (outcome === 'quarantined') {
      finalStatus = 'QUARANTINED'; executionStatus = 'EXECUTION_SUCCEEDED'; actionStatus = 'applied';
      decision = { kind: 'finish', reason: 'spurious' };
    }
    return {
      runId: `base-${taskCase.id}`, taskId: taskCase.id, pipelineId: taskCase.suite,
      executionStatus, finalStatus, actionStatus, decision, evidenceClaims,
      cost: taskCase.cost, latencyMs: taskCase.latencyMs,
      routing: { node: { agentId: 'fixture' } },
      startedAt: '2026-08-23T00:00:00.000Z',
      finishedAt: new Date(Date.parse('2026-08-23T00:00:00.000Z') + (taskCase.latencyMs ?? 100)).toISOString(),
    };
  };
}

test('re-evaluating the same immutable run with the same evaluator version reproduces identical scores', async () => {
  const env = makeEnv();
  try {
    const ev = ruleEvaluator({ rules: [{ id: 'status', field: 'finalStatus', op: 'eq', value: 'COMPLETED' }] });
    const run = { runId: 'immutable-1', finalStatus: 'COMPLETED', cost: 3, latencyMs: 500 };
    const a = await evaluate({ run, evaluator: ev, now: '2026-08-23T00:00:00.000Z' });
    const b = await evaluate({ run, evaluator: ev, now: '2026-08-23T00:00:00.000Z' });
    assert.deepEqual(a, b, 'identical evaluation for identical inputs');
    assert.deepEqual(a.scores, { status: 1 });
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('LLM-judge scores are reported separately and never override failed tests', async () => {
  const tests = testEvaluator();
  const judge = llmJudgeEvaluator({ judge: async () => 'excellent' });
  const run = { runId: 'judge-run', finalStatus: 'FAILED', cost: 1, latencyMs: 10 };
  const testResult = await evaluate({ run, evaluator: tests, evidence: [{ kind: 'test', passed: false, sourcePath: 't.test.mjs' }], now: 't' });
  const judgeResult = await evaluate({ run, evaluator: judge, now: 't' });
  assert.equal(testResult.overall, 'fail');
  const combined = combineEvaluations([testResult, judgeResult]);
  assert.equal(combined.overall, 'fail', 'judge approval must not flip a failed test');
  assert.equal(combined.llmJudge.verdict, 'excellent', 'judge output remains reported');
});

test('the system answers success rate, cost, latency and failure distribution for the fixed suite', async () => {
  const env = makeEnv();
  try {
    const catalog = taskCaseCatalog({ baseDir: process.cwd() });
    const baseline = await freezeBaseline({ catalog, runCase: makeRunCase(), store: env.store, now: '2026-08-23T00:00:00.000Z' });
    assert.ok(baseline.caseCount >= 50);
    // Persist the frozen trajectory rows so the dashboard-style query answers.
    for (const row of baseline.rows) env.store.appendRow('trajectory', row);
    const rows = env.store.readRows('trajectory');
    const summary = trajectorySummary(rows);
    assert.ok(summary.total >= 50, `frozen baseline has ${summary.total} cases`);
    assert.equal(typeof summary.successRate, 'number');
    assert.equal(typeof summary.avgCostUsd, 'number');
    assert.equal(typeof summary.avgLatencyMs, 'number');
    assert.ok(Object.keys(summary.failureDistribution).length >= 1, 'failure distribution is non-empty');
    assert.ok(Object.keys(summary.byAgent).length >= 1);
    assert.ok(Object.keys(summary.byWorkflow).length >= 3, 'all three suites represented');
    // Per-agent and per-workflow answers.
    const alice = queryTrajectory({ rows, agent: 'fixture' });
    assert.equal(alice.length, rows.length);
    const coding = queryTrajectory({ rows, workflow: 'coding' });
    assert.equal(coding.length, 15);
    const failed = queryTrajectory({ rows, status: 'FAILED' });
    assert.ok(failed.length > 0);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('redacted benchmark run export/import round-trips without content', async () => {
  const env = makeEnv();
  try {
    const catalog = taskCaseCatalog({ baseDir: process.cwd() });
    const baseline = await freezeBaseline({ catalog, runCase: makeRunCase(), store: env.store, now: '2026-08-23T00:00:00.000Z' });
    const payload = exportBenchmarkRun({ rows: baseline.rows, scoreRows: env.store.readRows('evaluation_score'), exportedAt: '2026-08-23T00:00:00.000Z' });
    const imported = importBenchmarkRun(payload);
    assert.equal(imported.rows.length, baseline.caseCount);
    assert.ok(imported.rows.every((r) => typeof r.runId === 'string'));
    // Contaminate and confirm rejection.
    const dirty = { ...payload, rows: [{ runId: 'x', content: 'leak' }] };
    assert.throws(() => importBenchmarkRun(dirty), (err) => err.code === 'BENCHMARK_EXCHANGE_NOT_REDACTED');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('trajectory persistence feeds the dashboard projection (persistTrajectory)', () => {
  const env = makeEnv();
  try {
    const row = persistTrajectory(env.store, {
      runId: 'live-run', taskId: 't', pipelineId: 'standard-development', executionStatus: 'EXECUTION_SUCCEEDED',
      finalStatus: 'COMPLETED', cost: 4, latencyMs: 900, startedAt: '2026-08-23T00:00:00.000Z',
      finishedAt: '2026-08-23T00:00:00.900Z', routing: { a: { agentId: 'alice' } }, evidenceClaims: [],
    });
    assert.equal(row.finalStatus, 'COMPLETED');
    const rows = env.store.readRows('trajectory');
    assert.equal(rows.length, 1);
    assert.equal(trajectorySummary(rows).successRate, 1);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
