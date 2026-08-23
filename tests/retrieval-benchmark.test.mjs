// Level 3 Task 8: retrieval benchmark harness and fixed baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { runRetrievalBenchmark, loadBenchmarkFixture } from '../core/retrieval-benchmark.mjs';

const DOCS = path.resolve('fixtures/knowledge/benchmark/documents');
const QUERIES = path.resolve('fixtures/knowledge/benchmark/queries.json');

test('benchmark runs over the fixed fixture and reports precision@5 and source coverage', () => {
  const ctx = loadBenchmarkFixture({ documentsDir: DOCS, queriesPath: QUERIES });
  try {
    const result = runRetrievalBenchmark({ index: ctx.index, benchmark: ctx.benchmark });
    assert.ok(result.precisionAt5 >= 0 && result.precisionAt5 <= 1, `precisionAt5 ${result.precisionAt5} out of range`);
    assert.ok(result.sourceCoverage >= 0 && result.sourceCoverage <= 1, `sourceCoverage ${result.sourceCoverage} out of range`);
    assert.equal(result.perQuery.length, ctx.benchmark.queries.length);
    for (const q of result.perQuery) {
      assert.equal(typeof q.precisionAt5, 'number');
      assert.ok(Array.isArray(q.top5));
      assert.ok(q.top5.length <= 5);
      // Scope boundary holds inside the benchmark: q-scope-guard is scoped to src/.
      if (q.id === 'q-scope-guard') {
        for (const p of q.top5) assert.ok(p.startsWith('src/'), `scope leak: ${p}`);
      }
    }
    // Record the baseline for the acceptance doc.
    console.log(`[benchmark] precisionAt5=${result.precisionAt5} sourceCoverage=${result.sourceCoverage}`);
  } finally {
    ctx.cleanup();
  }
});

test('benchmark is deterministic across two runs', () => {
  const ctx = loadBenchmarkFixture({ documentsDir: DOCS, queriesPath: QUERIES });
  try {
    const a = runRetrievalBenchmark({ index: ctx.index, benchmark: ctx.benchmark });
    const b = runRetrievalBenchmark({ index: ctx.index, benchmark: ctx.benchmark });
    assert.deepEqual(a, b);
  } finally {
    ctx.cleanup();
  }
});

test('benchmark rejects invalid inputs', () => {
  assert.throws(() => runRetrievalBenchmark({ index: [], benchmark: { queries: [] } }), (err) => err.code === 'BENCHMARK_QUERIES_INVALID');
  assert.throws(() => runRetrievalBenchmark({ index: 'x', benchmark: { queries: [{ id: 'a', gold: [] }] } }), (err) => err.code === 'BENCHMARK_INDEX_INVALID');
  assert.throws(() => runRetrievalBenchmark({ index: [], benchmark: { queries: [{ id: 'a' }] } }), (err) => err.code === 'BENCHMARK_GOLD_INVALID');
});
