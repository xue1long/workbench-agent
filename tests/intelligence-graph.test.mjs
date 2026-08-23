// Level 7 Task 1: evidence graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore } from '../core/store.mjs';
import { persistTrajectory } from '../core/trajectory.mjs';
import { defineEvaluator, evaluate } from '../core/evaluation.mjs';
import { proposeCandidate, transitionCandidate, candidateHistory } from '../core/candidates.mjs';
import { registerSource, storeContent } from '../core/intelligence/sources.mjs';
import { ingestSource } from '../core/intelligence/ingest.mjs';
import { buildGraph, queryNodes, queryEdges, path as findPath, neighborsOf, PROVENANCE } from '../core/intelligence/graph.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-graph-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  const objectsRoot = path.join(tmp, 'objects');
  return { tmp, store, objectsRoot };
}

function seed(env) {
  persistTrajectory(env.store, { runId: 'r-1', finalStatus: 'COMPLETED', cost: 1, latencyMs: 100, workflowId: 'standard-development', templateVersion: '1.0.0', startedAt: '2026-08-23T00:00:00.000Z', finishedAt: '2026-08-23T00:01:00.000Z', routing: { a: { agentId: 'fixture' } }, evidenceClaims: [{ kind: 'test' }] });
  const ev = defineEvaluator({ id: 'rule', version: '1.0.0', kind: 'rule', fn: async () => ({ scores: { status: 1 }, overall: 'pass' }) });
  return evaluate({ run: { runId: 'r-1', finalStatus: 'COMPLETED' }, evaluator: ev, store: env.store, evidence: [{ kind: 'test', sourcePath: 'tests/a.test.mjs' }], now: '2026-08-23T00:00:00.000Z' });
}

test('buildGraph materializes nodes from trajectory/evaluation/candidate/intelligence rows with EXTRACTED edges', async () => {
  const env = makeEnv();
  try {
    await seed(env);
    const src = { id: 'paper-1', kind: 'paper', canonicalUrl: 'https://x', retrievedAt: '2026-08-23T00:00:00.000Z', tier: 1, license: 'CC', terms: 'ok', retentionClass: 'keep', permission: 'granted', doi: '10.1/x' };
    registerSource({ store: env.store, source: src });
    ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: src, content: 'body', extracted: { problem: 'p' } });
    proposeCandidate({ store: env.store, id: 'cand-x', version: '1.0.0', scope: 'standard-development:1.0.0', rationale: 'r', evidenceLinks: ['traj:r-1', 'paper-1'], expectedEffect: 'e', rollbackTarget: 't', rule: { kind: 'routing', params: { agentWeightOverrides: { alice: 1 } } } });
    transitionCandidate({ store: env.store, candidateId: 'cand-x', to: 'evaluated', evidenceRef: 'bench:1', actor: 'benchmark' });
    const graph = buildGraph({ store: env.store });
    assert.ok(queryNodes({ graph, kind: 'trajectory' }).find((n) => n.id === 'r-1'));
    assert.ok(queryNodes({ graph, kind: 'evaluator' }).length >= 1);
    assert.ok(queryNodes({ graph, kind: 'candidate' }).find((n) => n.id === 'cand-x'));
    assert.ok(queryNodes({ graph, kind: 'intelligence_source' }).find((n) => n.id === 'paper-1'));
    assert.ok(queryNodes({ graph, kind: 'extraction' }).length >= 1);
    const evalEdges = queryEdges({ graph, kind: 'EVALUATED_BY' });
    assert.ok(evalEdges.every((e) => e.provenance === 'EXTRACTED'));
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('edges keep their provenance class — EXTRACTED vs INFERRED vs AMBIGUOUS', async () => {
  const env = makeEnv();
  try {
    await seed(env);
    proposeCandidate({ store: env.store, id: 'cand-y', version: '1.0.0', scope: 's', rationale: 'r', evidenceLinks: ['e'], expectedEffect: 'e', rollbackTarget: 't', rule: { kind: 'routing', params: {} } });
    env.store.appendRow('candidate_benchmark', { candidateId: 'cand-y', recordedAt: '2026-08-23T00:00:00.000Z', decision: 'reject', reasons: ['bench'], improvement: -0.1, ci95: { low: -0.2, high: 0.1, excludesZero: false } });
    const graph = buildGraph({ store: env.store });
    const benchEdges = queryEdges({ graph, kind: 'EVALUATED_BY', provenance: 'INFERRED' });
    assert.ok(benchEdges.some((e) => e.from === 'cand-y'), 'candidate->benchmark is INFERRED');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('path returns the chain from a candidate through benchmark back to source', async () => {
  const env = makeEnv();
  try {
    const src = { id: 'paper-2', kind: 'paper', canonicalUrl: 'https://y', retrievedAt: '2026-08-23T00:00:00.000Z', tier: 1, license: 'CC', terms: 'ok', retentionClass: 'keep', permission: 'granted', doi: '10.1/y' };
    registerSource({ store: env.store, source: src });
    ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: src, content: 'body' });
    proposeCandidate({ store: env.store, id: 'cand-z', version: '1.0.0', scope: 's', rationale: 'r', evidenceLinks: ['paper-2'], expectedEffect: 'e', rollbackTarget: 't', rule: { kind: 'routing', params: {} } });
    env.store.appendRow('candidate_benchmark', { candidateId: 'cand-z', recordedAt: '2026-08-23T00:00:00.000Z', decision: 'reject', reasons: ['bench'], improvement: -0.1, ci95: { low: -0.2, high: 0.1, excludesZero: false } });
    const graph = buildGraph({ store: env.store });
    const paths = findPath({ graph, fromId: 'cand-z', toId: 'paper-2' });
    assert.ok(paths.length >= 1, 'a path must exist');
    const allProvenance = paths.flat().map((e) => e.provenance);
    assert.ok(allProvenance.includes('INFERRED'), 'candidate -> source edges are INFERRED from evidenceLinks');
    const allKinds = paths.flat().map((e) => e.kind);
    assert.ok(allKinds.includes('REFERENCES'));
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('neighborsOf is bounded by maxDepth and includes provenance', async () => {
  const env = makeEnv();
  try {
    await seed(env);
    proposeCandidate({ store: env.store, id: 'cand-n', version: '1.0.0', scope: 's', rationale: 'r', evidenceLinks: ['r-1'], expectedEffect: 'e', rollbackTarget: 't', rule: { kind: 'routing', params: {} } });
    transitionCandidate({ store: env.store, candidateId: 'cand-n', to: 'evaluated', evidenceRef: 'bench:1', actor: 'benchmark' });
    const graph = buildGraph({ store: env.store });
    const nb = neighborsOf({ graph, id: 'cand-n', maxDepth: 2 });
    assert.ok(nb.nodes.some((n) => n.id === 'cand-n'));
    assert.ok(nb.edges.length >= 1, 'cand-n references r-1 via INFERRED');
    assert.ok(nb.edges.some((e) => e.provenance === 'INFERRED'));
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('PROVENANCE exposes the three classes and queryEdges filters by them', () => {
  assert.deepEqual(PROVENANCE, ['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);
});

test('graph query invalid inputs are rejected', () => {
  assert.throws(() => buildGraph({ store: null }), (err) => err.code === 'GRAPH_STORE_INVALID');
  assert.throws(() => queryNodes({ graph: null }), (err) => err.code === 'GRAPH_INVALID');
  assert.throws(() => findPath({ graph: { nodes: [], edges: [] }, fromId: null, toId: null }), (err) => err.code === 'GRAPH_PATH_INVALID');
  assert.throws(() => neighborsOf({ graph: null, id: 'a' }), (err) => err.code === 'GRAPH_NEIGHBORS_INVALID');
});
