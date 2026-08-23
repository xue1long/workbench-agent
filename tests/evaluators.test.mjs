// Level 4 Task 3: evaluator implementations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../core/evaluation.mjs';
import {
  ruleEvaluator,
  testEvaluator,
  staticAnalysisEvaluator,
  humanFeedbackEvaluator,
  llmJudgeEvaluator,
  combineEvaluations,
} from '../core/evaluators.mjs';

const runOk = { runId: 'run-ok', finalStatus: 'COMPLETED', cost: 5, latencyMs: 100, executionStatus: 'EXECUTION_SUCCEEDED' };
const runSlow = { runId: 'run-slow', finalStatus: 'COMPLETED', cost: 50, latencyMs: 9000, executionStatus: 'EXECUTION_SUCCEEDED' };

test('ruleEvaluator applies deterministic thresholds', async () => {
  const ev = ruleEvaluator({
    rules: [
      { id: 'status', field: 'finalStatus', op: 'eq', value: 'COMPLETED' },
      { id: 'cost', field: 'cost', op: 'lte', value: 20 },
      { id: 'latency', field: 'latencyMs', op: 'lte', value: 5000 },
    ],
  });
  const ok = await evaluate({ run: runOk, evaluator: ev, now: 't' });
  assert.deepEqual(ok.scores, { status: 1, cost: 1, latency: 1 });
  assert.equal(ok.overall, 'pass');
  const slow = await evaluate({ run: runSlow, evaluator: ev, now: 't' });
  assert.deepEqual(slow.scores, { status: 1, cost: 0, latency: 0 });
  assert.equal(slow.overall, 'fail');
});

test('testEvaluator scores required tests; a failing required test forces fail', async () => {
  const ev = testEvaluator();
  const pass = await evaluate({
    run: runOk, evaluator: ev, now: 't',
    evidence: [
      { kind: 'test', passed: true, sourcePath: 'a.test.mjs' },
      { kind: 'test', passed: true, sourcePath: 'b.test.mjs' },
    ],
  });
  assert.equal(pass.overall, 'pass');
  assert.deepEqual(pass.scores, { passed: 2, required: 2, passRate: 1 });
  const fail = await evaluate({
    run: runOk, evaluator: ev, now: 't',
    evidence: [
      { kind: 'test', passed: true, sourcePath: 'a.test.mjs' },
      { kind: 'test', passed: false, sourcePath: 'b.test.mjs' },
    ],
  });
  assert.equal(fail.overall, 'fail');
});

test('staticAnalysisEvaluator flags TODO, FIXME, trailing whitespace and oversized content', async () => {
  const ev = staticAnalysisEvaluator({ maxBytes: 50 });
  const dirty = await evaluate({
    run: runOk, evaluator: ev, now: 't',
    evidence: [{ kind: 'artifact', content: '// TODO fix this\nconst x = 1;  \n' }],
  });
  assert.equal(dirty.overall, 'fail');
  assert.ok(dirty.scores.todos >= 1);
  assert.ok(dirty.scores.trailingWhitespace >= 1);
  const clean = await evaluate({
    run: runOk, evaluator: ev, now: 't',
    evidence: [{ kind: 'artifact', content: 'const x = 1;\n' }],
  });
  assert.equal(clean.overall, 'pass');
});

test('humanFeedbackEvaluator records provided scores with actor provenance', async () => {
  const ev = humanFeedbackEvaluator({ minScore: 3 });
  const r = await evaluate({
    run: runOk, evaluator: ev, now: 't',
    evidence: [{ kind: 'human-feedback', actor: 'alice', scores: { clarity: 4, correctness: 5 } }],
  });
  assert.equal(r.overall, 'pass');
  assert.deepEqual(r.extra.actors, ['alice']);
  assert.equal(r.scores.clarity, 4);
});

test('llmJudgeEvaluator without a judge reports unavailable and stays separate', async () => {
  const ev = llmJudgeEvaluator();
  const r = await evaluate({ run: runOk, evaluator: ev, now: 't' });
  assert.equal(r.overall, null);
  assert.equal(r.deterministic, false);
  assert.deepEqual(r.llmJudge, { available: false, note: 'judge not configured' });
});

test('llm-judge pass can never override a failed test; judge fail cannot override deterministic pass', async () => {
  const judgePass = llmJudgeEvaluator({ judge: async () => 'looks good' });
  const judgeFail = llmJudgeEvaluator({ judge: async () => 'looks bad' });
  const tests = testEvaluator();
  const testFail = await evaluate({
    run: runOk, evaluator: tests, now: 't',
    evidence: [{ kind: 'test', passed: false, sourcePath: 'x.test.mjs' }],
  });
  const judgePassResult = await evaluate({ run: runOk, evaluator: judgePass, now: 't' });
  const combined = combineEvaluations([testFail, judgePassResult]);
  assert.equal(combined.overall, 'fail', 'a judge pass must not override a failed test');
  assert.equal(combined.llmJudge.verdict, 'looks good', 'judge output is still reported');

  const testPass = await evaluate({
    run: runOk, evaluator: tests, now: 't',
    evidence: [{ kind: 'test', passed: true, sourcePath: 'x.test.mjs' }],
  });
  const judgeFailResult = await evaluate({ run: runOk, evaluator: judgeFail, now: 't' });
  const combined2 = combineEvaluations([testPass, judgeFailResult]);
  assert.equal(combined2.overall, 'pass', 'a judge fail must not override deterministic pass');
});

test('combineEvaluations with no deterministic results yields null overall', () => {
  const judge = llmJudgeEvaluator({ judge: async () => ({ verdict: 'x' }) });
  assert.equal(combineEvaluations([{ deterministic: false, llmJudge: { available: true } }]).overall, null);
});
