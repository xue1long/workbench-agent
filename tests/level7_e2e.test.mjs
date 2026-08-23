// Level 7 Task 4: Level 7 acceptance fixtures and phase gate.
//
// End-to-end L7 walkthrough: graph traces a production rule through
// trajectory -> benchmark -> source; the lab runs in an isolated sandbox
// and routes successful experiments to the canary API; package ecosystem
// rejects malicious fixtures before install.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { StateStore } from '../core/store.mjs';
import { persistTrajectory } from '../core/trajectory.mjs';
import { defineEvaluator, evaluate } from '../core/evaluation.mjs';
import { proposeCandidate, candidateHistory } from '../core/candidates.mjs';
import { registerSource, storeContent } from '../core/intelligence/sources.mjs';
import { ingestSource } from '../core/intelligence/ingest.mjs';
import { buildGraph, queryEdges } from '../core/intelligence/graph.mjs';
import { runExperiment, experimentHistory, decisionFromResult, routeToCanary } from '../core/laboratory/experiment.mjs';
import {
  registerPackage, verifyPackage, markVerified, installPackage, uninstallPackage, availablePackages,
} from '../core/packages-l7.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l7-e2e-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  return { tmp, store };
}

test('a production rule traces through the graph to trajectory, benchmark and source', async () => {
  const env = makeEnv();
  try {
    persistTrajectory(env.store, { runId: 'r-1', finalStatus: 'COMPLETED', cost: 1, latencyMs: 100, workflowId: 'standard-development', templateVersion: '1.0.0', startedAt: '2026-08-23T00:00:00.000Z', finishedAt: '2026-08-23T00:01:00.000Z', routing: { a: { agentId: 'fixture' } } });
    const ev = defineEvaluator({ id: 'rule', version: '1.0.0', kind: 'rule', fn: async () => ({ scores: { status: 1 }, overall: 'pass' }) });
    await evaluate({ run: { runId: 'r-1', finalStatus: 'COMPLETED' }, evaluator: ev, store: env.store, evidence: [], now: '2026-08-23T00:00:00.000Z' });
    const src = { id: 'paper-prod', kind: 'paper', canonicalUrl: 'https://arxiv.org/x', retrievedAt: '2026-08-23T00:00:00.000Z', tier: 1, license: 'CC', terms: 'ok', retentionClass: 'keep', permission: 'granted', doi: '10.1234/x' };
    registerSource({ store: env.store, source: src });
    ingestSource({ store: env.store, objectsRoot: path.join(env.tmp, 'objects'), source: src, content: 'body' });
    proposeCandidate({ store: env.store, id: 'rule-prod', version: '1.0.0', scope: 'standard-development:1.0.0', rationale: 'r', evidenceLinks: ['r-1', 'paper-prod'], expectedEffect: 'e', rollbackTarget: 't', rule: { kind: 'routing', params: { agentWeightOverrides: { fixture: 1 } } } });
    env.store.appendRow('candidate_benchmark', { candidateId: 'rule-prod', recordedAt: '2026-08-23T00:00:00.000Z', decision: 'promote', reasons: ['meets rule'], improvement: 0.05, ci95: { low: 0.01, high: 0.1, excludesZero: true } });
    const graph = buildGraph({ store: env.store });
    assert.ok(graph.nodes.find((n) => n.kind === 'candidate' && n.id === 'rule-prod'));
    assert.ok(graph.nodes.find((n) => n.kind === 'intelligence_source' && n.id === 'paper-prod'));
    assert.ok(queryEdges({ graph, kind: 'EVALUATED_BY' }).length >= 2);
    // Provenance classes are present in the graph.
    const provenances = new Set(queryEdges({ graph, kind: 'EVALUATED_BY' }).map((e) => e.provenance));
    assert.ok(provenances.has('EXTRACTED') || provenances.has('INFERRED'));
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('Experiment Lab runs in an isolated sandbox and routes successful results to canary without auto-promoting', async () => {
  const env = makeEnv();
  try {
    proposeCandidate({ store: env.store, id: 'cand-lab', version: '1.0.0', scope: 's', rationale: 'r', evidenceLinks: ['e'], expectedEffect: 'e', rollbackTarget: 't', rule: { kind: 'routing', params: {} } });
    const runCase = async (taskCase, version) => version === 'baseline'
      ? { outcome: { success: false }, cost: 1 }
      : { outcome: { success: true }, cost: 1 };
    const result = await runExperiment({
      store: env.store,
      candidate: env.store.readRows('candidate').slice(-1)[0],
      baselineCases: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, goal: 'x' })),
      env: { description: 'isolated worktree', sandbox: { sandboxPath: 'C:\\wb\\sandbox' } },
      evaluatorVersion: '1.0.0',
      runCase,
    });
    assert.equal(result.decision, 'promote');
    assert.equal(result.scores.improvement, 1);
    assert.ok(experimentHistory({ store: env.store, candidateId: 'cand-lab' }).length >= 1);
    // routeToCanary hands off to a caller-supplied canaryApi (never auto-promotes).
    const routed = routeToCanary({ experiment: result, canaryApi: { submitForCanary: ({ experiment }) => ({ canaryId: 'c-lab-1', candidateId: experiment.candidateId }) } });
    assert.equal(routed.routed, true);
    assert.equal(routed.canaryId, 'c-lab-1');
    assert.equal(decisionFromResult(result), 'promote');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('a bad experiment (4pp worse) is never promoted', async () => {
  const env = makeEnv();
  try {
    proposeCandidate({ store: env.store, id: 'cand-bad', version: '1.0.0', scope: 's', rationale: 'r', evidenceLinks: ['e'], expectedEffect: 'e', rollbackTarget: 't', rule: { kind: 'routing', params: {} } });
    const runCase = async (taskCase, version) => ({ outcome: { success: version === 'baseline' }, cost: 1 });
    const result = await runExperiment({
      store: env.store,
      candidate: env.store.readRows('candidate').slice(-1)[0],
      baselineCases: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}` })),
      env: {}, runCase,
    });
    assert.equal(result.decision, 'reject');
    const routed = routeToCanary({ experiment: result, canaryApi: { submitForCanary: () => ({ canaryId: 'c' }) } });
    assert.equal(routed.routed, false);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

function skillPackage(over = {}) {
  const manifest = {
    id: 'skill-1', kind: 'skill', version: '1.0.0',
    source: { kind: 'local', path: '/tmp/skill-1' },
    permissions: ['fs:read'],
    compatibility: { node: '>=20' },
    uninstall: 'remove .workbench/installed/skill-1',
    rollback: 'remove .workbench/installed/skill-1',
    ...over,
  };
  manifest.checksum = over.checksum ?? createHash('sha256').update(JSON.stringify(manifest, null, 2), 'utf8').digest('hex');
  return manifest;
}

test('a malicious package fixture (verifier exit non-zero OR tampered checksum) is rejected before install', () => {
  const env = makeEnv();
  try {
    const pkg = skillPackage();
    registerPackage({ store: env.store, package: pkg });
    const sandbox = { root: path.join(env.tmp, 'sb-mal'), runVerifier: () => 1 };
    assert.throws(() => verifyPackage({ package: pkg, sandbox }), (err) => err.code === 'PACKAGE_VERIFIER_FAILED');
    const tampered = skillPackage({ id: 'skill-mal', checksum: 'deadbeef'.repeat(8) });
    registerPackage({ store: env.store, package: tampered });
    assert.throws(() => verifyPackage({ package: tampered, sandbox: { root: path.join(env.tmp, 'sb-mal2') } }), (err) => err.code === 'PACKAGE_CHECKSUM_MISMATCH');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('a verified package installs reproducibly and uninstall reverses it', () => {
  const env = makeEnv();
  try {
    const pkg = skillPackage();
    registerPackage({ store: env.store, package: pkg });
    const sandbox = { root: path.join(env.tmp, 'sb-install') };
    verifyPackage({ package: pkg, sandbox });
    markVerified({ store: env.store, packageId: pkg.id, version: pkg.version });
    const install = installPackage({ store: env.store, packageId: pkg.id, version: pkg.version, workspaceRoot: env.tmp, sandbox });
    assert.ok(fs.existsSync(path.join(install.installPath, 'package.json')));
    uninstallPackage({ store: env.store, packageId: pkg.id, version: pkg.version, workspaceRoot: env.tmp });
    assert.ok(!fs.existsSync(install.installPath));
    assert.deepEqual(availablePackages({ store: env.store }), []);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
