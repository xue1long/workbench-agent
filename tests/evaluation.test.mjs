// Level 4 Task 2: evaluate(run, evaluator) boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore } from '../core/store.mjs';
import { defineEvaluator, evaluate, latestScores, rawEvidenceRows, EvaluationError, EVALUATOR_KINDS } from '../core/evaluation.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-eval-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  return { tmp, store };
}

const run = { runId: 'run-1', finalStatus: 'COMPLETED', cost: 5, latencyMs: 100 };

test('defineEvaluator freezes id/version/kind/fn and validates inputs', () => {
  const ev = defineEvaluator({ id: 'rule', version: '1.0.0', kind: 'rule', fn: async () => ({ scores: {} }) });
  assert.equal(ev.id, 'rule');
  assert.equal(ev.version, '1.0.0');
  assert.equal(ev.kind, 'rule');
  assert.ok(Object.isFrozen(ev));
  assert.throws(() => defineEvaluator({ id: '', version: '1', kind: 'rule', fn: async () => ({}) }), (err) => err.code === 'EVALUATOR_ID_INVALID');
  assert.throws(() => defineEvaluator({ id: 'x', version: '', kind: 'rule', fn: async () => ({}) }), (err) => err.code === 'EVALUATOR_VERSION_INVALID');
  assert.throws(() => defineEvaluator({ id: 'x', version: '1', kind: 'magic', fn: async () => ({}) }), (err) => err.code === 'EVALUATOR_KIND_INVALID');
  assert.throws(() => defineEvaluator({ id: 'x', version: '1', kind: 'rule' }), (err) => err.code === 'EVALUATOR_FN_INVALID');
  assert.deepEqual(EVALUATOR_KINDS, ['rule', 'test', 'static-analysis', 'human-feedback', 'llm-judge']);
});

test('evaluate returns a frozen result and persists raw and score rows separately', async () => {
  const env = makeEnv();
  try {
    const ev = defineEvaluator({
      id: 'rule', version: '1.0.0', kind: 'rule',
      fn: async ({ run: r }) => ({ scores: { success: r.finalStatus === 'COMPLETED' ? 1 : 0 }, overall: r.finalStatus === 'COMPLETED' ? 'pass' : 'fail' }),
    });
    const evidence = [{ kind: 'test', contentHash: 'a'.repeat(64), byteCount: 10, sourcePath: 'tests/a.test.mjs' }];
    const result = await evaluate({ run, evaluator: ev, store: env.store, evidence, now: '2026-08-23T10:00:00.000Z' });
    assert.equal(result.runId, 'run-1');
    assert.equal(result.evaluator.id, 'rule');
    assert.deepEqual(result.scores, { success: 1 });
    assert.equal(result.overall, 'pass');
    assert.equal(result.deterministic, true);
    assert.equal(result.llmJudge, null);
    assert.equal(result.rawEvidence.length, 1);
    assert.ok(Object.isFrozen(result));
    // Raw and score rows are separate tables; neither mixes the other's fields.
    const raw = env.store.readRows('evaluation_raw');
    const scores = env.store.readRows('evaluation_score');
    assert.equal(raw.length, 1);
    assert.equal(scores.length, 1);
    assert.equal(raw[0].evidenceKind, 'test');
    assert.equal(typeof raw[0].scores, 'undefined', 'raw rows must not carry scores');
    assert.equal(typeof scores[0].contentHash, 'undefined', 'score rows must not carry raw evidence content');
    assert.deepEqual(scores[0].scores, { success: 1 });
    assert.equal(scores[0].evaluatorVersion, '1.0.0');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('evaluate is deterministic: same inputs reproduce identical scores', async () => {
  const env = makeEnv();
  try {
    const ev = defineEvaluator({
      id: 'rule', version: '1.0.0', kind: 'rule',
      fn: async ({ run: r }) => ({ scores: { cost: r.cost * 2, latency: r.latencyMs }, overall: 'pass' }),
    });
    const a = await evaluate({ run, evaluator: ev, store: env.store, now: '2026-08-23T10:00:00.000Z' });
    const b = await evaluate({ run, evaluator: ev, store: env.store, now: '2026-08-23T10:00:00.000Z' });
    assert.deepEqual(a, b);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('strictVersion rejects re-evaluating a run with a different evaluator version', async () => {
  const env = makeEnv();
  try {
    const fn = async () => ({ scores: { ok: 1 } });
    const v1 = defineEvaluator({ id: 'rule', version: '1.0.0', kind: 'rule', fn });
    const v2 = defineEvaluator({ id: 'rule', version: '2.0.0', kind: 'rule', fn });
    await evaluate({ run, evaluator: v1, store: env.store, now: '2026-08-23T10:00:00.000Z' });
    await assert.rejects(
      () => evaluate({ run, evaluator: v2, store: env.store, now: '2026-08-23T10:00:00.000Z', strictVersion: true }),
      (err) => err instanceof EvaluationError && err.code === 'EVALUATION_VERSION_MISMATCH',
    );
    // Without strictVersion the newer version is allowed (compat re-eval).
    const ok = await evaluate({ run, evaluator: v2, store: env.store, now: '2026-08-23T10:00:00.000Z' });
    assert.equal(ok.evaluator.version, '2.0.0');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('evaluator output without a scores object is rejected', async () => {
  const ev = defineEvaluator({ id: 'bad', version: '1', kind: 'rule', fn: async () => ({ nope: true }) });
  await assert.rejects(() => evaluate({ run, evaluator: ev }), (err) => err.code === 'EVALUATION_RESULT_INVALID');
});

test('latestScores and rawEvidenceRows read back persisted evaluation state', async () => {
  const env = makeEnv();
  try {
    const ev = defineEvaluator({
      id: 'test', version: '1.0.0', kind: 'test',
      fn: async ({ evidence }) => {
        const passed = evidence.filter((e) => e.kind === 'test' && e.passed === true).length;
        return { scores: { passed, required: evidence.length }, overall: passed === evidence.length ? 'pass' : 'fail' };
      },
    });
    const evidence = [
      { kind: 'test', contentHash: 'b'.repeat(64), sourcePath: 'tests/x.test.mjs', passed: true },
      { kind: 'test', contentHash: 'c'.repeat(64), sourcePath: 'tests/y.test.mjs', passed: false },
    ];
    await evaluate({ run, evaluator: ev, store: env.store, evidence, now: '2026-08-23T10:00:00.000Z' });
    const scores = latestScores(env.store, { runId: 'run-1' });
    assert.equal(scores.length, 1);
    assert.equal(scores[0].overall, 'fail');
    const raw = rawEvidenceRows(env.store, { runId: 'run-1' });
    assert.equal(raw.length, 2);
    assert.ok(raw.every((r) => typeof r.contentHash === 'string'));
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
