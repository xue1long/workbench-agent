// Level 3 Task 8: fixed retrieval benchmark.
//
// Reports precision@5 and source coverage over a frozen benchmark fixture so
// future retrieval changes (including a deferred semantic/vector variant)
// can be compared against a recorded baseline. Deterministic: re-running the
// same index + benchmark produces identical numbers.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { retrieve } from './knowledge-retrieval.mjs';
import { createKnowledgeStore } from './knowledge-store.mjs';
import { StateStore } from './store.mjs';

export class RetrievalBenchmarkError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'RetrievalBenchmarkError';
    this.code = code;
    if (details) this.details = details;
  }
}

export function runRetrievalBenchmark({ index, benchmark }) {
  if (!Array.isArray(index)) {
    throw new RetrievalBenchmarkError('BENCHMARK_INDEX_INVALID', 'index must be an array');
  }
  if (!benchmark || !Array.isArray(benchmark.queries) || benchmark.queries.length === 0) {
    throw new RetrievalBenchmarkError('BENCHMARK_QUERIES_INVALID', 'benchmark must contain at least one query');
  }
  const allGold = new Set();
  for (const q of benchmark.queries) {
    if (!Array.isArray(q.gold)) {
      throw new RetrievalBenchmarkError('BENCHMARK_GOLD_INVALID', `query ${q.id} must declare a gold array`);
    }
    for (const g of q.gold) allGold.add(g);
  }
  const perQuery = [];
  const retrievedGold = new Set();
  for (const q of benchmark.queries) {
    const res = retrieve({ index, query: q.query, scope: q.scope, budgetChars: 100000 });
    const top5 = res.items.slice(0, 5).map((i) => i.sourcePath);
    const goldSet = new Set(q.gold);
    const hits = top5.filter((p) => goldSet.has(p));
    for (const p of hits) retrievedGold.add(p);
    perQuery.push({
      id: q.id,
      query: q.query,
      scope: q.scope,
      gold: [...q.gold],
      top5,
      hits,
      precisionAt5: hits.length / 5,
    });
  }
  const precisionAt5 = perQuery.reduce((acc, q) => acc + q.precisionAt5, 0) / perQuery.length;
  const sourceCoverage = allGold.size === 0 ? 0 : retrievedGold.size / allGold.size;
  return {
    precisionAt5: round3(precisionAt5),
    sourceCoverage: round3(sourceCoverage),
    perQuery: perQuery.map((q) => ({ ...q, precisionAt5: round3(q.precisionAt5) })),
    benchmarkVersion: benchmark.version ?? '1.0.0',
  };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

// Load the fixed benchmark fixture: documents are ingested through the
// KnowledgeStore and materialized into an index with inline content, ready
// for retrieve(). The temp store/objects dir is removed by cleanup().
export function loadBenchmarkFixture({ documentsDir, queriesPath }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bench-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  const k = createKnowledgeStore({ store, objectsRoot: path.join(tmp, 'objects') });
  const out = k.ingestDirectory({ dir: documentsDir, scope: '.' });
  if (out.ingested.length === 0) {
    throw new RetrievalBenchmarkError('BENCHMARK_FIXTURE_EMPTY', 'benchmark fixture ingested no documents');
  }
  const rows = k.list();
  // The fixture documents live under docs/ and src/; their scope is derived
  // from the top-level path segment so scope-scoped queries work.
  const index = rows.map((row) => {
    const first = row.sourcePath.split('/')[0];
    return { ...row, scope: `${first}/`, content: k.content(row) };
  });
  const benchmark = JSON.parse(fs.readFileSync(queriesPath, 'utf8'));
  return {
    index,
    benchmark,
    tmp,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}
