// Level 6 Task 3: normalization.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSource } from '../core/intelligence/normalize.mjs';

const paperSource = {
  id: 'paper-1', kind: 'paper', tier: 1,
  canonicalUrl: 'https://arxiv.org/abs/2501.00001', retrievedAt: '2026-08-23T00:00:00.000Z',
  doi: '10.1234/test',
};

test('default extractor finds headings and keyword capability hints', () => {
  const content = `# Routing Improvements for Agent Workbenches

Problem: routing scores are opaque and unstable across versions.
Method: we learn per-agent weights from historical trajectory quality.
Evidence: 8% success-rate improvement across 1k tasks.
Limitations: single-domain evaluation; calibration sensitive.`;
  const n = normalizeSource({ source: paperSource, content, version: 1, now: '2026-08-23T01:00:00.000Z' });
  assert.equal(n.sourceId, 'paper-1');
  assert.equal(n.tier, 1);
  assert.match(n.problem, /routing scores/);
  assert.match(n.method, /per-agent weights/);
  assert.match(n.evidence, /8% success/);
  assert.match(n.limitations, /single-domain/);
  assert.equal(n.applicableCapability, 'orchestrator_routing');
  assert.equal(n.provenance.canonicalUrl, paperSource.canonicalUrl);
  assert.equal(n.provenance.doi, '10.1234/test');
  assert.equal(n.normalizedAt, '2026-08-23T01:00:00.000Z');
});

test('explicit extractor overrides the default heuristic', () => {
  const extractor = ({ content }) => ({
    problem: 'p', method: 'm', evidence: 'e', limitations: 'l', applicableCapability: 'custom_cap',
  });
  const n = normalizeSource({ source: paperSource, content: 'unused', version: 2, extractor });
  assert.equal(n.problem, 'p');
  assert.equal(n.method, 'm');
  assert.equal(n.evidence, 'e');
  assert.equal(n.limitations, 'l');
  assert.equal(n.applicableCapability, 'custom_cap');
  assert.equal(n.version, 2);
});

test('empty content falls back to default limitations', () => {
  const n = normalizeSource({ source: paperSource, content: '' });
  assert.match(n.limitations, /single source/);
  assert.equal(n.problem, '');
});

test('invalid input is rejected', () => {
  assert.throws(() => normalizeSource({ source: null, content: 'x' }), (err) => err.code === 'NORMALIZE_SOURCE_INVALID');
});
