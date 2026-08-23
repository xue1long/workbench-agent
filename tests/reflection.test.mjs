// Level 5 Task 1: reflection signal ranking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankReflectionCandidates, candidateTopicsSummary, taskClassOf, ReflectionError } from '../core/reflection.mjs';

function row(runId, workflowId, overrides = {}) {
  return {
    runId, workflowId, templateVersion: '1.0.0', finalStatus: 'COMPLETED',
    cost: 5, latencyMs: 1000, evidenceRefs: ['test'], ...overrides,
  };
}

test('topics are bucketed by versioned task class and ranked deterministically', () => {
  const rows = [
    row('a', 'standard-development', { finalStatus: 'FAILED', cost: 15, latencyMs: 9000 }),
    row('b', 'standard-development', { finalStatus: 'FAILED', cost: 18, latencyMs: 9500 }),
    row('c', 'standard-development', { finalStatus: 'COMPLETED', cost: 3, latencyMs: 500 }),
    row('d', 'task', { finalStatus: 'COMPLETED', cost: 2, latencyMs: 300 }),
  ];
  const topics = rankReflectionCandidates({ rows });
  assert.equal(topics.length, 2);
  const sd = topics.find((t) => t.taskClass === 'standard-development:1.0.0');
  assert.equal(sd.total, 3);
  assert.equal(sd.failures, 2);
  assert.ok(sd.score > topics.find((t) => t.taskClass === 'task:1.0.0').score, 'the failing class must rank first');
  assert.equal(topics[0].taskClass, 'standard-development:1.0.0');
});

function failingClassRows(workflowId, { failures, difficulty, cost = 5, latencyMs = 1000 }) {
  const rows = [];
  for (let i = 0; i < 3; i += 1) {
    rows.push(row(`${workflowId}-${i}`, workflowId, {
      finalStatus: i < failures ? 'FAILED' : 'COMPLETED',
      cost, latencyMs, difficulty,
    }));
  }
  return rows;
}

test('repeated-failure signal dominates by default weight', () => {
  // x: 3/3 failures, easy; y: 1/3 failures, hard. Default weights favour the
  // repeated-failure signal, so x ranks first despite being easy.
  const rows = [
    ...failingClassRows('x', { failures: 3, difficulty: 0.1 }),
    ...failingClassRows('y', { failures: 1, difficulty: 0.9 }),
  ];
  const topics = rankReflectionCandidates({ rows });
  const x = topics.find((t) => t.taskClass === 'x:1.0.0');
  const y = topics.find((t) => t.taskClass === 'y:1.0.0');
  assert.ok(x.score > y.score, `repeated failure must dominate (x=${x.score} vs y=${y.score})`);
  assert.equal(topics[0].taskClass, 'x:1.0.0');
});

test('weights change the ranking', () => {
  const rows = [
    ...failingClassRows('x', { failures: 3, difficulty: 0.1 }),
    ...failingClassRows('y', { failures: 1, difficulty: 0.9 }),
  ];
  const defaultRank = rankReflectionCandidates({ rows });
  const difficultyRank = rankReflectionCandidates({ rows, weights: { difficulty: 10, uncertainty: 0, businessValue: 0, repeatedFailure: 0 } });
  assert.equal(defaultRank[0].taskClass, 'x:1.0.0');
  assert.equal(difficultyRank[0].taskClass, 'y:1.0.0');
});

test('business values influence the score', () => {
  const rows = [row('a', 'x', { finalStatus: 'FAILED' })];
  const low = rankReflectionCandidates({ rows, businessValues: { 'x:1.0.0': 0.1 } })[0];
  const high = rankReflectionCandidates({ rows, businessValues: { 'x:1.0.0': 1 } })[0];
  assert.ok(high.score > low.score);
});

test('ranking is deterministic across runs', () => {
  const rows = [
    row('a', 'standard-development', { finalStatus: 'FAILED' }),
    row('b', 'task', { finalStatus: 'COMPLETED' }),
    row('c', 'standard-development', { finalStatus: 'COMPLETED' }),
  ];
  const a = rankReflectionCandidates({ rows });
  const b = rankReflectionCandidates({ rows });
  assert.deepEqual(a, b);
});

test('summary returns the top N with reasons', () => {
  const rows = [row('a', 'x', { finalStatus: 'FAILED' }), row('b', 'y', { finalStatus: 'FAILED' })];
  const topics = rankReflectionCandidates({ rows });
  const summary = candidateTopicsSummary(topics, 1);
  assert.equal(summary.length, 1);
  assert.ok(Array.isArray(summary[0].reasons));
  assert.ok(summary[0].reasons.some((r) => r.includes('failures')));
});

test('taskClassOf is stable', () => {
  assert.equal(taskClassOf({ workflowId: 'standard-development', templateVersion: '1.0.0' }), 'standard-development:1.0.0');
  assert.equal(taskClassOf({}), 'task:v1');
});

test('invalid rows are rejected', () => {
  assert.throws(() => rankReflectionCandidates({ rows: 'x' }), (err) => err instanceof ReflectionError && err.code === 'REFLECTION_ROWS_INVALID');
});
