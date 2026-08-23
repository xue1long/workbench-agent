// Level 4 Task 6: redacted benchmark exchange.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportBenchmarkRun, importBenchmarkRun, BenchmarkExchangeError } from '../core/benchmark-exchange.mjs';

const rows = [
  {
    runId: 'r-1', workflowId: 'standard-development', finalStatus: 'COMPLETED', failureClass: 'none',
    agentIds: ['alice'], cost: 5, latencyMs: 1000,
    artifactHashes: ['a'.repeat(64)],
    evidenceRefs: ['test'],
  },
  {
    runId: 'r-2', workflowId: 'task', finalStatus: 'FAILED', failureClass: 'stage-failed',
    agentIds: ['bob'], cost: 50, latencyMs: 9000,
  },
];
const scoreRows = [
  { runId: 'r-1', evaluatorId: 'rule', evaluatorVersion: '1.0.0', evaluatorKind: 'rule', scores: { status: 1 }, overall: 'pass', deterministic: true },
];

test('export produces a redacted, versioned payload', () => {
  const payload = exportBenchmarkRun({ rows, scoreRows, exportedAt: '2026-08-23T00:00:00.000Z' });
  assert.equal(payload.format, 'workbench-benchmark-1');
  assert.equal(payload.redacted, true);
  assert.equal(payload.runCount, 2);
  assert.equal(payload.scoreCount, 1);
  assert.equal(payload.rows.length, 2);
  assert.equal(payload.rows[0].artifactHashes[0], 'a'.repeat(64), 'hashes travel');
  assert.equal(typeof payload.rows[0].cost, 'number');
});

test('sensitive content is stripped, never carried', () => {
  const dirtyRows = [
    { runId: 'r-x', finalStatus: 'COMPLETED', prompt: 'secret prompt', context: ['secret'], content: 'secret body', stdout: 'secret output', scores: { ok: 1 } },
  ];
  const payload = exportBenchmarkRun({ rows: dirtyRows, exportedAt: 't' });
  assert.equal(payload.rows[0].prompt, null);
  assert.equal(payload.rows[0].context, null);
  assert.equal(payload.rows[0].content, null);
  assert.equal(payload.rows[0].stdout, null);
  assert.ok(!JSON.stringify(payload).includes('secret prompt'));
  assert.ok(!JSON.stringify(payload).includes('secret output'));
});

test('import round-trips a clean payload', () => {
  const payload = exportBenchmarkRun({ rows, scoreRows, exportedAt: '2026-08-23T00:00:00.000Z' });
  const imported = importBenchmarkRun(payload);
  assert.equal(imported.rows.length, 2);
  assert.equal(imported.scoreRows.length, 1);
  assert.equal(imported.validation.runCount, 2);
  assert.deepEqual(imported.rows[0].artifactHashes, ['a'.repeat(64)]);
});

test('import rejects non-redacted payloads and unknown formats', () => {
  assert.throws(
    () => importBenchmarkRun({ format: 'workbench-benchmark-1', redacted: true, rows: [{ runId: 'r', content: 'leak' }] }),
    (err) => err instanceof BenchmarkExchangeError && err.code === 'BENCHMARK_EXCHANGE_NOT_REDACTED',
  );
  assert.throws(
    () => importBenchmarkRun({ format: 'old-format', redacted: true, rows: [] }),
    (err) => err instanceof BenchmarkExchangeError && err.code === 'BENCHMARK_EXCHANGE_FORMAT_UNKNOWN',
  );
  assert.throws(
    () => importBenchmarkRun({ format: 'workbench-benchmark-1', redacted: false, rows: [] }),
    (err) => err instanceof BenchmarkExchangeError && err.code === 'BENCHMARK_EXCHANGE_NOT_REDACTED',
  );
  assert.throws(
    () => exportBenchmarkRun({ rows: 'x' }),
    (err) => err.code === 'BENCHMARK_EXCHANGE_ROWS_INVALID',
  );
});
