// Level 6 Task 4: tier ranking and Candidate Patterns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankSources, generateCandidatePattern, tracePattern, candidatePatterns } from '../core/intelligence/patterns.mjs';

function record(over = {}) {
  return {
    sourceId: over.sourceId ?? 'paper-1', version: over.version ?? 1, tier: over.tier ?? 1,
    problem: over.problem ?? 'p', method: over.method ?? 'm', evidence: over.evidence ?? 'e',
    limitations: over.limitations ?? 'l', applicableCapability: over.applicableCapability ?? 'routing',
    normalizedAt: over.normalizedAt ?? '2026-08-23T00:00:00.000Z',
    provenance: { canonicalUrl: 'https://example', retrievedAt: '2026-08-23T00:00:00.000Z' },
  };
}

test('rankSources orders Tier 1/2 before 3/4 and within tier by date desc', () => {
  const ranked = rankSources([
    record({ sourceId: 't4', tier: 4, normalizedAt: '2026-08-23T03:00:00.000Z' }),
    record({ sourceId: 't1-old', tier: 1, normalizedAt: '2026-08-23T01:00:00.000Z' }),
    record({ sourceId: 't1-new', tier: 1, normalizedAt: '2026-08-23T02:00:00.000Z' }),
    record({ sourceId: 't3', tier: 3 }),
  ]);
  assert.deepEqual(ranked.map((r) => r.sourceId), ['t1-new', 't1-old', 't3', 't4']);
});

test('Tier 1/2 records produce experiment-eligible patterns', () => {
  for (const tier of [1, 2]) {
    const p = generateCandidatePattern({ normalized: record({ tier }) });
    assert.equal(p.experimentEligible, true, `tier ${tier}`);
    assert.equal(p.evidenceTier, tier);
    assert.ok(p.sourceRefs.length === 1);
  }
});

test('Tier 3/4 sources alone cannot create experiment-eligible patterns', () => {
  for (const tier of [3, 4]) {
    const p = generateCandidatePattern({ normalized: record({ tier }) });
    assert.equal(p.experimentEligible, false, `tier ${tier}`);
    assert.ok(/secondary/i.test(p.risk));
  }
});

test('patterns trace back to exact source/version records (real store)', async () => {
  const fs = await import('node:fs'); const path = await import('node:path'); const os = await import('node:os');
  const { StateStore } = await import('../core/store.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pat-'));
  try {
    const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
    store.appendRow('intelligence_source', { id: 'paper-1', kind: 'paper', canonicalUrl: 'https://x', retrievedAt: 't', tier: 1, license: 'L', terms: 'T', retentionClass: 'keep', permission: 'granted' });
    store.appendRow('intelligence_ingestion', { sourceId: 'paper-1', dedupeKey: 'url:https://x', contentHash: 'h'.repeat(64), version: 1, status: 'created', bodyStored: true, ingestedAt: 't' });
    store.appendRow('intelligence_extraction', { sourceId: 'paper-1', version: 1, contentHash: 'h'.repeat(64), extracted: { problem: 'p' }, extractedAt: 't' });
    const pattern = { id: 'p1', sourceRefs: [{ sourceId: 'paper-1', version: 1 }] };
    const trace = tracePattern(pattern, store);
    assert.equal(trace.sources.length, 1);
    assert.equal(trace.sources[0].source.canonicalUrl, 'https://x');
    assert.equal(trace.sources[0].ingestion.version, 1);
    assert.equal(trace.sources[0].extraction.extracted.problem, 'p');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('candidatePatterns batches over normalizedRecords', () => {
  const out = candidatePatterns({ normalizedRecords: [record({ sourceId: 'a', tier: 1 }), record({ sourceId: 'b', tier: 4 })] });
  assert.equal(out.length, 2);
  assert.equal(out[0].experimentEligible, true);
  assert.equal(out[1].experimentEligible, false);
});

test('rankSources rejects invalid input', () => {
  assert.throws(() => rankSources('x'), (err) => err.code === 'PATTERN_INPUT_INVALID');
});
