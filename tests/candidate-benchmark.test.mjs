// Level 5 Task 4: offline candidate benchmark with paired bootstrap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore } from '../core/store.mjs';
import { runCandidateBenchmark, promotionDecision, recordBenchmark, CandidateBenchmarkError } from '../core/candidate-benchmark.mjs';

function makeCases(ids) {
  return { cases: ids.map((id) => ({ id })) };
}

// evaluateCase double: baseline/candidate success patterns per case id.
function makeEvaluateCase(patterns) {
  return async (taskCase, version) => {
    const p = patterns[version][taskCase.id] ?? { success: true, securityPass: true, correctnessPass: true, cost: 1, latencyMs: 100 };
    return p;
  };
}

const good = (over = {}) => ({ success: true, securityPass: true, correctnessPass: true, cost: 1, latencyMs: 100, ...over });
const bad = (over = {}) => ({ success: false, securityPass: true, correctnessPass: true, cost: 1, latencyMs: 100, ...over });

test('a clear paired improvement promotes; CI excludes zero', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
  const baseline = makeCases(ids);
  const candidate = { id: 'cand-1', scope: 'standard-development:1.0.0' };
  const patterns = {
    baseline: Object.fromEntries(ids.map((id, i) => [id, i < 14 ? good() : bad()])), // 70%
    candidate: Object.fromEntries(ids.map((id, i) => [id, good()])), // 100%
  };
  const result = await runCandidateBenchmark({ baseline, candidate, evaluateCase: makeEvaluateCase(patterns) });
  assert.equal(result.improvement, 0.3);
  const decision = promotionDecision(result);
  assert.equal(decision.decision, 'promote');
  assert.ok(result.ci95.excludesZero, 'CI must exclude zero for a 30pp improvement');
});

test('a sub-5pp improvement is rejected', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const baseline = makeCases(ids);
  const candidate = { id: 'cand-2', scope: 'x:1.0.0' };
  // baseline 80%, candidate 80% -> 0pp
  const patterns = {
    baseline: Object.fromEntries(ids.map((id, i) => [id, i < 8 ? good() : bad()])),
    candidate: Object.fromEntries(ids.map((id, i) => [id, i < 8 ? good() : bad()])),
  };
  const result = await runCandidateBenchmark({ baseline, candidate, evaluateCase: makeEvaluateCase(patterns) });
  const decision = promotionDecision(result);
  assert.equal(decision.decision, 'reject');
  assert.ok(decision.reasons.some((r) => r.includes('0.05')));
});

test('a security/correctness regression rejects even with improvement', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const baseline = makeCases(ids);
  const candidate = { id: 'cand-3', scope: 'x:1.0.0' };
  const patterns = {
    baseline: Object.fromEntries(ids.map((id, i) => [id, i < 7 ? good() : bad()])),
    candidate: Object.fromEntries(ids.map((id, i) => [id, i === 9 ? good({ securityPass: false }) : good()])),
  };
  const result = await runCandidateBenchmark({ baseline, candidate, evaluateCase: makeEvaluateCase(patterns) });
  assert.equal(result.candidateSuccessRate, 1);
  const decision = promotionDecision(result);
  assert.equal(decision.decision, 'reject');
  assert.ok(decision.reasons.some((r) => r.includes('regression')));
});

test('a budget breach rejects even with improvement', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const baseline = makeCases(ids);
  const candidate = { id: 'cand-4', scope: 'x:1.0.0' };
  const patterns = {
    baseline: Object.fromEntries(ids.map((id, i) => [id, i < 7 ? good() : bad()])),
    candidate: Object.fromEntries(ids.map((id, i) => [id, good({ cost: 100 })])),
  };
  const result = await runCandidateBenchmark({ baseline, candidate, evaluateCase: makeEvaluateCase(patterns), budget: { maxCostUsd: 10 } });
  assert.equal(result.budgetOk, false);
  const decision = promotionDecision(result);
  assert.equal(decision.decision, 'reject');
  assert.ok(decision.reasons.some((r) => r.includes('budget')));
});

test('the benchmark is deterministic for a fixed seed', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
  const baseline = makeCases(ids);
  const candidate = { id: 'cand-5', scope: 'x:1.0.0' };
  const patterns = {
    baseline: Object.fromEntries(ids.map((id, i) => [id, i < 12 ? good() : bad()])),
    candidate: Object.fromEntries(ids.map((id, i) => [id, i < 17 ? good() : bad()])),
  };
  const a = await runCandidateBenchmark({ baseline, candidate, evaluateCase: makeEvaluateCase(patterns), seed: 7 });
  const b = await runCandidateBenchmark({ baseline, candidate, evaluateCase: makeEvaluateCase(patterns), seed: 7 });
  assert.deepEqual(a.ci95, b.ci95);
  assert.equal(a.improvement, b.improvement);
});

test('recordBenchmark appends the experiment record', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cbench-'));
  try {
    const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const result = await runCandidateBenchmark({
      baseline: makeCases(ids), candidate: { id: 'cand-6', scope: 'x' },
      evaluateCase: makeEvaluateCase({
        baseline: Object.fromEntries(ids.map((id, i) => [id, i < 10 ? good() : bad()])),
        candidate: Object.fromEntries(ids.map((id, i) => [id, good()])),
      }),
    });
    assert.equal(result.improvement, 0.5);
    const row = recordBenchmark({ store, candidateId: 'cand-6', result, decision: promotionDecision(result) });
    assert.equal(row.decision, 'promote');
    assert.equal(store.readRows('candidate_benchmark').length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('invalid inputs are rejected', async () => {
  await assert.rejects(() => runCandidateBenchmark({ baseline: { cases: [] }, candidate: { id: 'x', scope: 's' }, evaluateCase: async () => ({}) }), (err) => err.code === 'BENCH_BASELINE_INVALID');
  await assert.rejects(() => runCandidateBenchmark({ baseline: { cases: [{ id: 'a' }] }, candidate: { id: 'x', scope: 's' } }), (err) => err.code === 'BENCH_EVALUATECASE_INVALID');
  assert.throws(() => recordBenchmark({ store: null, candidateId: 'x', result: {}, decision: { decision: 'reject' } }), (err) => err.code === 'BENCH_STORE_INVALID');
});
