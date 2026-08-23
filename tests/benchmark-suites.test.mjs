// Level 4 Task 4: fixed benchmark suites and frozen baselines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore } from '../core/store.mjs';
import { taskCaseCatalog, freezeBaseline, baselineSummary } from '../core/benchmark-suites.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bsuite-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  return { tmp, store };
}

// Deterministic run-case double: outcome -> run report.
function makeRunCase() {
  return (taskCase) => {
    const outcome = taskCase.outcome;
    let finalStatus = 'COMPLETED';
    let executionStatus = 'EXECUTION_SUCCEEDED';
    let failureClass = null;
    let evidenceClaims = [];
    let actionStatus = 'applied';
    let decision = { kind: 'finish' };
    if (outcome === 'test-fail') {
      finalStatus = 'FAILED';
      executionStatus = 'EXECUTION_SUCCEEDED';
      actionStatus = 'no_candidates';
      evidenceClaims = [{ kind: 'test', passed: false, sourcePath: 'tests/x.test.mjs' }];
      decision = { kind: 'halt', reason: 'tests failed' };
      failureClass = 'no-candidate';
    } else if (outcome === 'stage-fail') {
      finalStatus = 'FAILED';
      executionStatus = 'FAILED';
      actionStatus = 'stage_failed';
      decision = { kind: 'halt', reason: 'stage failed' };
    } else if (outcome === 'blocked') {
      finalStatus = 'FAILED';
      executionStatus = 'FAILED';
      actionStatus = 'stage_failed';
      decision = { kind: 'halt', reason: 'dependency failed' };
    } else if (outcome === 'budget') {
      finalStatus = 'FAILED';
      executionStatus = 'FAILED';
      actionStatus = 'stage_failed';
      decision = { kind: 'halt', reason: 'task budget exhausted' };
    } else if (outcome === 'deadline') {
      finalStatus = 'FAILED';
      executionStatus = 'FAILED';
      actionStatus = 'stage_failed';
      decision = { kind: 'halt', reason: 'deadline passed' };
    } else if (outcome === 'no-candidate') {
      finalStatus = 'FAILED';
      executionStatus = 'EXECUTION_SUCCEEDED';
      actionStatus = 'no_candidates';
      decision = { kind: 'halt', reason: 'no successful nodes produced candidates' };
    } else if (outcome === 'approval') {
      finalStatus = 'AWAITING_APPROVAL';
      executionStatus = 'EXECUTION_SUCCEEDED';
      actionStatus = 'awaiting_approval';
      decision = { kind: 'continue', reason: 'awaiting human approval' };
    } else if (outcome === 'quarantined') {
      finalStatus = 'QUARANTINED';
      executionStatus = 'EXECUTION_SUCCEEDED';
      actionStatus = 'applied';
      decision = { kind: 'finish', reason: 'spurious' };
    }
    return {
      runId: `base-${taskCase.id}`,
      taskId: taskCase.id,
      pipelineId: taskCase.suite,
      executionStatus,
      finalStatus,
      failureClass,
      actionStatus,
      decision,
      evidenceClaims,
      cost: taskCase.cost,
      latencyMs: taskCase.latencyMs,
      routing: { node: { agentId: 'fixture' } },
      startedAt: '2026-08-23T00:00:00.000Z',
      finishedAt: new Date(Date.parse('2026-08-23T00:00:00.000Z') + (taskCase.latencyMs ?? 100)).toISOString(),
    };
  };
}

test('catalog freezes at least 50 representative cases across three suites', () => {
  const catalog = taskCaseCatalog({ baseDir: process.cwd() });
  assert.ok(catalog.length >= 50, `catalog has ${catalog.length} cases`);
  const suites = new Set(catalog.map((c) => c.suite));
  assert.deepEqual([...suites].sort(), ['coding', 'orchestration', 'retrieval']);
  const ids = new Set(catalog.map((c) => c.id));
  assert.equal(ids.size, catalog.length, 'case ids must be unique');
  for (const c of catalog) assert.ok(Object.isFrozen(c));
});

test('freezeBaseline records trajectory + evaluation rows and a score snapshot', async () => {
  const env = makeEnv();
  try {
    const catalog = taskCaseCatalog({ baseDir: process.cwd() });
    const baseline = await freezeBaseline({ catalog, runCase: makeRunCase(), store: env.store, now: '2026-08-23T00:00:00.000Z' });
    assert.equal(baseline.caseCount, catalog.length);
    assert.ok(baseline.caseCount >= 50);
    assert.equal(baseline.rows.length, catalog.length);
    assert.equal(baseline.scoreRows.length, catalog.length);
    assert.equal(typeof baseline.scoreSnapshot, 'string');
    assert.equal(baseline.scoreSnapshot.length, 64);
    const scores = env.store.readRows('evaluation_score');
    assert.equal(scores.length, catalog.length * 2, 'rule + test per case');
    const raw = env.store.readRows('evaluation_raw');
    assert.ok(raw.length >= 0);
    const summary = baseline.summary;
    assert.equal(summary.caseCount, catalog.length);
    assert.ok(summary.passRate > 0 && summary.passRate <= 1);
    assert.deepEqual(Object.keys(summary.bySuite).sort(), ['coding', 'orchestration', 'retrieval']);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('re-freezing the same catalog reproduces an identical score snapshot', async () => {
  const env = makeEnv();
  try {
    const catalog = taskCaseCatalog({ baseDir: process.cwd() });
    const runCase = makeRunCase();
    const a = await freezeBaseline({ catalog, runCase, store: env.store, now: '2026-08-23T00:00:00.000Z' });
    const b = await freezeBaseline({ catalog, runCase, store: env.store, now: '2026-08-23T00:00:00.000Z' });
    assert.equal(a.scoreSnapshot, b.scoreSnapshot);
    assert.deepEqual(a.summary, b.summary);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('baselineSummary reports pass rate and per-suite aggregates', async () => {
  const env = makeEnv();
  try {
    const catalog = taskCaseCatalog({ baseDir: process.cwd() });
    const baseline = await freezeBaseline({ catalog, runCase: makeRunCase(), store: env.store, now: '2026-08-23T00:00:00.000Z' });
    const summary = baselineSummary(baseline.rows, baseline.scoreRows);
    assert.equal(summary.caseCount, baseline.caseCount);
    assert.ok(summary.passCount > 0);
    assert.ok(typeof summary.bySuite.orchestration.successRate === 'number');
    assert.ok(typeof summary.bySuite.coding.avgCostUsd === 'number');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
