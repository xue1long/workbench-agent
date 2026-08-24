// Level 6 Task 5: Level 6 acceptance fixtures and phase gate.
//
// Full lifecycle: register rights → ingest (idempotent, versioning) →
// normalize → rank → Candidate Pattern → trace. A secondary-source-only
// candidate is never experiment-eligible.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore } from '../core/store.mjs';
import { registerSource, storeContent } from '../core/intelligence/sources.mjs';
import { ingestSource, extractionAt, sourceVersions } from '../core/intelligence/ingest.mjs';
import { normalizeSource } from '../core/intelligence/normalize.mjs';
import { rankSources, generateCandidatePattern, tracePattern, candidatePatterns } from '../core/intelligence/patterns.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l6-e2e-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  const objectsRoot = path.join(tmp, 'objects');
  return { tmp, store, objectsRoot };
}

function paper(over = {}) {
  const base = {
    id: 'paper-1', kind: 'paper', canonicalUrl: 'https://arxiv.org/abs/2501.00001',
    retrievedAt: '2026-08-23T00:00:00.000Z', tier: 1,
    license: 'CC-BY-4.0', terms: 'ok', retentionClass: 'keep', permission: 'granted',
    doi: '10.1234/arXiv.2501.00001',
  };
  // Allow`null` to override (e.g. link-only sources without license).
  for (const [k, v] of Object.entries(over)) base[k] = v;
  return base;
}

test('full lifecycle: Tier 1 source produces an experiment-eligible pattern traceable back to source/version', () => {
  const env = makeEnv();
  try {
    const src = paper();
    registerSource({ store: env.store, source: src });
    const first = ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: src, content: 'arXiv body v1' });
    assert.equal(first.status, 'created');
    const second = ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: src, content: 'arXiv body v1' });
    assert.equal(second.status, 'unchanged', 'reprocessing unchanged sources is idempotent');
    assert.equal(env.store.readRows('intelligence_extraction').length, 1, 'no new extraction rows for unchanged');
    const updated = ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: src, content: 'arXiv body v2', extracted: { problem: 'p', method: 'm', evidence: 'e', limitations: 'l', applicableCapability: 'orchestrator_routing' } });
    assert.equal(updated.status, 'updated');
    assert.equal(updated.version, 2);
    const versions = sourceVersions({ store: env.store, sourceId: src.id });
    assert.deepEqual(versions.map((v) => v.status), ['created', 'unchanged', 'updated']);
    assert.ok(extractionAt({ store: env.store, sourceId: src.id, version: 1 }) != null, 'old extraction preserved');
    const extraction = extractionAt({ store: env.store, sourceId: src.id, version: 2 });
    const normalized = normalizeSource({ source: src, content: 'unused', version: 2, extractor: () => extraction.extracted });
    const ranked = rankSources([normalized]);
    assert.equal(ranked[0].tier, 1);
    const pattern = generateCandidatePattern({ normalized: ranked[0] });
    assert.equal(pattern.experimentEligible, true);
    assert.deepEqual(pattern.sourceRefs, [{ sourceId: src.id, version: 2 }]);
    const trace = tracePattern(pattern, env.store);
    assert.equal(trace.sources.length, 1);
    assert.equal(trace.sources[0].source.canonicalUrl, src.canonicalUrl);
    assert.equal(trace.sources[0].ingestion.version, 2);
    assert.equal(trace.sources[0].extraction.extracted.problem, 'p');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('Tier 3/4 sources alone cannot create experiment-eligible candidates', () => {
  const env = makeEnv();
  try {
    const community = paper({ id: 'comm-1', tier: 3, doi: '10.1234/community', canonicalUrl: 'https://community/x' });
    const blog = paper({ id: 'blog-1', tier: 4, doi: '10.1234/blog', canonicalUrl: 'https://blog/x' });
    registerSource({ store: env.store, source: community });
    registerSource({ store: env.store, source: blog });
    ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: community, content: 'c1' });
    ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: blog, content: 'b1' });
    const ex = extractionAt({ store: env.store, sourceId: 'comm-1', version: 1 });
    const ex2 = extractionAt({ store: env.store, sourceId: 'blog-1', version: 1 });
    const normalizedCommunity = normalizeSource({ source: community, content: '', version: 1, extractor: () => ({ problem: 'p1', method: 'm', evidence: 'e', limitations: 'l' }) });
    const normalizedBlog = normalizeSource({ source: blog, content: '', version: 1, extractor: () => ({ problem: 'p2', method: 'm', evidence: 'e', limitations: 'l' }) });
    const patterns = candidatePatterns({ normalizedRecords: [normalizedCommunity, normalizedBlog] });
    assert.ok(patterns.every((p) => p.experimentEligible === false), 'secondary sources must never produce experiment-eligible patterns');
    assert.ok(patterns.every((p) => /secondary/i.test(p.risk)));
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('link-only sources store metadata but not body', () => {
  const env = makeEnv();
  try {
    const src = paper({ id: 'p-link', retentionClass: 'link-only', permission: 'unknown', license: null, terms: null, doi: '10.1234/link', canonicalUrl: 'https://link/x' });
    registerSource({ store: env.store, source: src });
    const meta = storeContent({ store: env.store, objectsRoot: env.objectsRoot, sourceId: src.id, content: 'hidden' });
    assert.equal(meta.bodyStored, false);
    assert.equal(meta.reason.length > 0, true);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
