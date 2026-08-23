// Level 7 Task 2: experiment lab.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore } from '../core/store.mjs';
import { proposeCandidate } from '../core/candidates.mjs';
import { runExperiment, experimentHistory, decisionFromResult, routeToCanary, ExperimentError } from '../core/laboratory/experiment.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lab-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  return { tmp, store };
}

const cases = [
  { id: 'a', goal: 'p' },
  { id: 'b', goal: 'p' },
  { id: 'c', goal: 'p' },
  { id: 'd', goal: 'p' },
  { id: 'e', goal: 'p' },
];

function makeCandidate(env) {
  return proposeCandidate({
    id: 'cand-lab', version: '1.0.0', scope: 's', rationale: 'r', evidenceLinks: ['e'], expectedEffect: 'e', rollbackTarget: 't', store: env.store,
    rule: { kind: 'routing', params: { agentWeightOverrides: { alice: 1 } } },
  });
}

test('runExperiment records an ExperimentRecord with env/inputs/outputs/evidence/scores', async () => {
  const env = makeEnv();
  try {
    const candidate = makeCandidate(env);
    const runCase = async (taskCase, version) => {
      // baseline: 2/5 succeed; candidate: 4/5 succeed → +0.4 → promote.
      const baseOk = taskCase.id === 'a' || taskCase.id === 'b';
      const candOk = taskCase.id === 'a' || taskCase.id === 'b' || taskCase.id === 'c' || taskCase.id === 'd';
      return version === 'baseline'
        ? { outcome: { success: baseOk }, cost: 1, evidence: [{ kind: 'test', sourcePath: 't.test.mjs' }] }
        : { outcome: { success: candOk }, cost: 1.2, evidence: [{ kind: 'test', sourcePath: 't.test.mjs' }] };
    };
    const result = await runExperiment({
      store: env.store, candidate, baselineCases: cases,
      env: { description: 'sandbox', sandbox: { sandboxPath: '/tmp/sb' } }, evaluatorVersion: '2.0.0',
      runCase,
    });
    assert.equal(result.candidateId, 'cand-lab');
    assert.equal(result.scores.improvement, 0.4);
    assert.equal(result.decision, 'promote');
    assert.equal(result.evaluatorVersion, '2.0.0');
    assert.equal(result.outputs.length, 5);
    assert.equal(result.evidenceRefs.length, 5);
    assert.equal(result.sandboxPath, '/tmp/sb');
    assert.match(result.evaluatorHash, /^[a-f0-9]{64}$/);
    assert.equal(env.store.readRows('experiment').length, 1);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('experimentHistory filters by candidateId', async () => {
  const env = makeEnv();
  try {
    const candidate = makeCandidate(env);
    await runExperiment({
      store: env.store, candidate, baselineCases: cases,
      env: { description: 'a' }, runCase: async (c, v) => ({ outcome: { success: true }, cost: 1 }),
    });
    assert.equal(experimentHistory({ store: env.store, candidateId: 'cand-lab' }).length, 1);
    assert.equal(experimentHistory({ store: env.store, candidateId: 'other' }).length, 0);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('decisionFromResult mirrors the recorded decision', async () => {
  const env = makeEnv();
  try {
    const candidate = makeCandidate(env);
    const r = await runExperiment({
      store: env.store, candidate, baselineCases: cases,
      env: {}, runCase: async (c, v) => ({ outcome: { success: v === 'candidate' }, cost: 1 }),
    });
    assert.equal(decisionFromResult(r), r.decision);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('routeToCanary refuses non-promote experiments and missing canary API', async () => {
  const env = makeEnv();
  try {
    const candidate = makeCandidate(env);
    const runCase = async (c, v) => ({ outcome: { success: v === 'candidate' }, cost: 1 });
    const r = await runExperiment({
      store: env.store, candidate, baselineCases: cases,
      env: {}, runCase,
    });
    const rejected = await runExperiment({
      store: env.store, candidate, baselineCases: cases,
      env: {}, runCase: async () => ({ outcome: { success: false }, cost: 1 }),
    });
    assert.equal(rejected.decision, 'reject');
    assert.deepEqual(routeToCanary({ experiment: rejected }), { routed: false, reason: 'experiment is not promote-eligible' });
    assert.deepEqual(routeToCanary({ experiment: r }), { routed: false, reason: 'canaryApi.submitForCanary is required' });
    let submitted;
    const api = { submitForCanary: ({ experiment }) => { submitted = experiment.id; return { canaryId: 'c1' }; } };
    const routed = routeToCanary({ experiment: r, canaryApi: api });
    assert.equal(routed.routed, true);
    assert.equal(routed.canaryId, 'c1');
    assert.equal(submitted, r.id);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('runExperiment rejects missing arguments', async () => {
  const env = makeEnv();
  try {
    await assert.rejects(() => runExperiment({ store: env.store, candidate: null, baselineCases: cases, env: {}, runCase: async () => ({}) }), (err) => err.code === 'EXPERIMENT_CANDIDATE_INVALID');
    await assert.rejects(() => runExperiment({ store: env.store, candidate: { id: 'x' }, baselineCases: [], env: {}, runCase: async () => ({}) }), (err) => err.code === 'EXPERIMENT_BASELINE_INVALID');
    await assert.rejects(() => runExperiment({ store: env.store, candidate: { id: 'x' }, baselineCases: cases, env: {}, runCase: null }), (err) => err.code === 'EXPERIMENT_RUNCASE_INVALID');
    await assert.rejects(() => runExperiment({ store: null, candidate: { id: 'x' }, baselineCases: cases, env: {}, runCase: async () => ({}) }), (err) => err.code === 'EXPERIMENT_STORE_INVALID');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
