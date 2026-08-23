// Level 4 Task 4: fixed benchmark suites and frozen baselines.
//
// The task-case catalog freezes 50 representative cases across the
// orchestration, coding and retrieval suites. freezeBaseline() runs each case
// through a caller-supplied deterministic runner, records trajectory rows and
// versioned evaluation scores, and snapshots the scores. Re-freezing the same
// catalog with the same runner reproduces an identical score snapshot
// (determinism gate), which is what makes later promotion decisions legal.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { recordRun, trajectorySummary } from './trajectory.mjs';
import { evaluate } from './evaluation.mjs';
import { ruleEvaluator, testEvaluator } from './evaluators.mjs';

export class BenchmarkSuitesError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'BenchmarkSuitesError';
    this.code = code;
    if (details) this.details = details;
  }
}

const RETRIEVAL_CASES = [
  { id: 'r-01', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 40, goal: 'oauth login redirect exchange' },
  { id: 'r-02', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 35, goal: 'token refresh expiry storage' },
  { id: 'r-03', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 38, goal: 'billing invoice payment ledger' },
  { id: 'r-04', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 30, goal: 'architecture design components' },
  { id: 'r-05', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 32, goal: 'provider configuration scopes' },
  { id: 'r-06', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 41, goal: 'workspace sync lockfile snapshot' },
  { id: 'r-07', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 33, goal: 'cli commands pipeline status' },
  { id: 'r-08', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 36, goal: 'git adapter apply patch commit' },
  { id: 'r-09', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 39, goal: 'contributing review process tests' },
  { id: 'r-10', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 34, goal: 'workspace config manifest load' },
  { id: 'r-11', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 37, goal: 'token expiry isExpired check' },
  { id: 'r-12', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 42, goal: 'authorize url build scopes' },
  { id: 'r-13', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 31, goal: 'payment record ledger entry' },
  { id: 'r-14', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 35, goal: 'restore snapshot lockfile priority' },
  { id: 'r-15', kind: 'retrieval-query', outcome: 'success', cost: 0, latencyMs: 36, goal: 'redirect uri callback register' },
];

function loadCases(file, suite, version) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (payload.suite !== suite || !Array.isArray(payload.cases)) {
    throw new BenchmarkSuitesError('BENCHMARK_CATALOG_INVALID', `${file} must declare suite ${suite} and a cases array`);
  }
  return payload.cases.map((c) => ({ ...c, suite, catalogVersion: version }));
}

export function taskCaseCatalog({ baseDir = process.cwd() } = {}) {
  const version = '1.0.0';
  const orchestration = loadCases(path.join(baseDir, 'fixtures/evaluation/orchestration-cases.json'), 'orchestration', version);
  const coding = loadCases(path.join(baseDir, 'fixtures/evaluation/coding-cases.json'), 'coding', version);
  const retrieval = RETRIEVAL_CASES.map((c) => ({ ...c, suite: 'retrieval', catalogVersion: version }));
  const all = [...orchestration, ...coding, ...retrieval];
  if (all.length < 50) {
    throw new BenchmarkSuitesError('BENCHMARK_CATALOG_TOO_SMALL', `catalog has ${all.length} cases; at least 50 required`);
  }
  return Object.freeze(all.map((c) => Object.freeze({ ...c })));
}

// runCase(case) -> a run report (deterministic double of a Level 2/3 run).
// freezeBaseline records a trajectory row per case plus rule + test
// evaluation scores, and snapshots the scores for promotion comparisons.
export async function freezeBaseline({ catalog, runCase, store, now = '2026-08-23T00:00:00.000Z', evaluatorVersions = { rule: '1.0.0', test: '1.0.0' } }) {
  if (!Array.isArray(catalog) || typeof runCase !== 'function' || !store) {
    throw new BenchmarkSuitesError('BENCHMARK_FREEZE_INVALID', 'freezeBaseline requires catalog, runCase and store');
  }
  const rule = ruleEvaluator({
    version: evaluatorVersions.rule,
    rules: [
      { id: 'status', field: 'finalStatus', op: 'eq', value: 'COMPLETED' },
      { id: 'cost', field: 'cost', op: 'lte', value: 20 },
      { id: 'latency', field: 'latencyMs', op: 'lte', value: 6000 },
    ],
  });
  const test = testEvaluator({ version: evaluatorVersions.test });
  const rows = [];
  const scoreRows = [];
  for (const taskCase of catalog) {
    const report = runCase(taskCase);
    const row = recordRun({ run: { ...report, runId: report.runId ?? `base-${taskCase.id}`, taskId: report.taskId ?? taskCase.id, cost: report.cost ?? taskCase.cost, latencyMs: report.latencyMs ?? taskCase.latencyMs, workflowId: taskCase.suite, startedAt: report.startedAt ?? '2026-08-23T00:00:00.000Z', finishedAt: report.finishedAt ?? '2026-08-23T00:01:00.000Z' } });
    rows.push(row);
    const evidence = report.evidenceClaims ?? [];
    const r1 = await evaluate({ run: row, evaluator: rule, store, evidence, now });
    const r2 = await evaluate({ run: row, evaluator: test, store, evidence, now });
    scoreRows.push({
      caseId: taskCase.id,
      suite: taskCase.suite,
      runId: row.runId,
      rule: { overall: r1.overall, scores: r1.scores },
      test: { overall: r2.overall, scores: r2.scores },
    });
  }
  return {
    frozenAt: now,
    caseCount: rows.length,
    evaluatorVersions,
    rows,
    scoreRows,
    scoreSnapshot: hashSnapshot(scoreRows),
    summary: baselineSummary(rows, scoreRows),
  };
}

function hashSnapshot(scoreRows) {
  return createHash('sha256').update(JSON.stringify(scoreRows)).digest('hex');
}

export function baselineSummary(rows, scoreRows) {
  const bySuite = {};
  const suites = [...new Set(rows.map((r) => r.workflowId))];
  for (const suite of suites) {
    const suiteRows = rows.filter((r) => r.workflowId === suite);
    bySuite[suite] = trajectorySummary(suiteRows);
  }
  const overall = trajectorySummary(rows);
  const passCount = (scoreRows ?? []).filter((s) => s.rule.overall === 'pass').length;
  return {
    caseCount: rows.length,
    passCount,
    passRate: rows.length === 0 ? 0 : Math.round((passCount / rows.length) * 1000) / 1000,
    bySuite,
    overall,
  };
}
