// Level 5 Task 6: Level 5 acceptance fixtures and phase gate.
//
// Full candidate lifecycle walkthroughs: propose → evaluate → benchmark →
// approve → promote → canary → success; and the reject path. Candidate
// history explains every transition; rollback restores the previous version
// without deleting history; a seeded bad candidate is rejected; a canary
// breach auto-disables.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore } from '../core/store.mjs';
import { proposeCandidate, transitionCandidate, candidateHistory } from '../core/candidates.mjs';
import { runCandidateBenchmark, promotionDecision, recordBenchmark } from '../core/candidate-benchmark.mjs';
import {
  approve, promote, canarySlice, reportCanaryResult, autoDisable, rollback, promotedCandidates,
} from '../core/canary.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l5-e2e-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  return { tmp, store };
}

const good = () => ({ success: true, securityPass: true, correctnessPass: true, cost: 1, latencyMs: 100 });
const bad = () => ({ success: false, securityPass: true, correctnessPass: true, cost: 1, latencyMs: 100 });

function baseCases(n) {
  return { cases: Array.from({ length: n }, (_, i) => ({ id: `c${i}` })) };
}

function proposeRoutingCandidate(env, id, overrides = {}) {
  return proposeCandidate({
    id, version: '1.0.0', scope: 'standard-development:1.0.0',
    rationale: 'contrast shows best runs used alice',
    evidenceLinks: ['traj:best', 'traj:worst'],
    expectedEffect: '+5pp success rate',
    rollbackTarget: 'routing-default',
    rule: { kind: 'routing', params: { agentWeightOverrides: { alice: 1.5 } } },
    store: env.store, actor: 'reflection-engine',
    ...overrides,
  });
}

test('full lifecycle: history explains propose/evaluate/approve/promote/canary; no breach keeps the candidate', async () => {
  const env = makeEnv();
  try {
    const c = proposeRoutingCandidate(env, 'cand-good');
    transitionCandidate({ store: env.store, candidateId: c.id, to: 'evaluated', evidenceRef: 'bench:1', actor: 'benchmark' });
    // Benchmark passes: 70% -> 100% on 20 paired cases.
    const result = await runCandidateBenchmark({
      baseline: baseCases(20),
      candidate: c,
      evaluateCase: async (taskCase, version) => {
        const i = Number(taskCase.id.slice(1));
        if (version === 'baseline') return i < 14 ? good() : bad();
        return good();
      },
    });
    const decision = promotionDecision(result);
    assert.equal(decision.decision, 'promote');
    recordBenchmark({ store: env.store, candidateId: c.id, result, decision });
    approve({ store: env.store, candidateId: c.id, actor: 'alice' });
    promote({ store: env.store, candidateId: c.id });
    assert.deepEqual(promotedCandidates({ store: env.store }).map((x) => x.id), [c.id]);
    // Canary: 30 eligible runs, at most ~10% selected; all succeed.
    for (let i = 0; i < 30; i += 1) {
      if (canarySlice({ store: env.store, candidateId: c.id, runId: `live-${i}` })) {
        reportCanaryResult({ store: env.store, candidateId: c.id, runId: `live-${i}`, success: true });
      }
    }
    const disabled = autoDisable({ store: env.store, candidateId: c.id, baselineSuccessRate: 0.9 });
    assert.equal(disabled.disabled, false);
    // History tells the full story with actors and evidence refs.
    const history = candidateHistory({ store: env.store, candidateId: c.id });
    assert.deepEqual(history.map((h) => h.to), ['proposed', 'evaluated', 'approved', 'promoted']);
    assert.equal(history.find((h) => h.to === 'approved').actor, 'alice');
    assert.ok(history.find((h) => h.to === 'evaluated').evidenceRef.includes('bench'));
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('a seeded bad candidate is rejected by the promotion decision', async () => {
  const env = makeEnv();
  try {
    const c = proposeRoutingCandidate(env, 'cand-bad');
    const result = await runCandidateBenchmark({
      baseline: baseCases(20),
      candidate: c,
      evaluateCase: async (taskCase, version) => {
        const i = Number(taskCase.id.slice(1));
        if (version === 'baseline') return i < 16 ? good() : bad(); // 80%
        return i < 12 ? good() : bad(); // 60% — 20pp WORSE
      },
    });
    assert.ok(result.improvement < 0, 'candidate must be measurably worse');
    const decision = promotionDecision(result);
    assert.equal(decision.decision, 'reject');
    // The reject path: evaluated -> rejected.
    transitionCandidate({ store: env.store, candidateId: c.id, to: 'evaluated', evidenceRef: 'bench:1', actor: 'benchmark' });
    transitionCandidate({ store: env.store, candidateId: c.id, to: 'rejected', evidenceRef: 'bench:reject', actor: 'benchmark' });
    const history = candidateHistory({ store: env.store, candidateId: c.id });
    assert.deepEqual(history.map((h) => h.to), ['proposed', 'evaluated', 'rejected']);
    assert.deepEqual(promotedCandidates({ store: env.store }), []);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('rollback restores the previous version and preserves the complete history', () => {
  const env = makeEnv();
  try {
    const c = proposeRoutingCandidate(env, 'cand-roll');
    transitionCandidate({ store: env.store, candidateId: c.id, to: 'evaluated', evidenceRef: 'bench:1', actor: 'benchmark' });
    approve({ store: env.store, candidateId: c.id, actor: 'alice' });
    promote({ store: env.store, candidateId: c.id });
    const out = rollback({ store: env.store, candidateId: c.id, actor: 'alice' });
    assert.equal(out.previousVersion, 'routing-default');
    const history = candidateHistory({ store: env.store, candidateId: c.id });
    assert.deepEqual(history.map((h) => h.to), ['proposed', 'evaluated', 'approved', 'promoted', 'rolled-back']);
    assert.equal(history[history.length - 1].evidenceRef, 'rollback:human');
    assert.deepEqual(promotedCandidates({ store: env.store }), []);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('a canary threshold breach disables the candidate automatically', () => {
  const env = makeEnv();
  try {
    const c = proposeRoutingCandidate(env, 'cand-breach');
    transitionCandidate({ store: env.store, candidateId: c.id, to: 'evaluated', evidenceRef: 'bench:1', actor: 'benchmark' });
    approve({ store: env.store, candidateId: c.id, actor: 'alice' });
    promote({ store: env.store, candidateId: c.id });
    for (let i = 0; i < 6; i += 1) {
      reportCanaryResult({ store: env.store, candidateId: c.id, runId: `r-${i}`, success: i < 2 });
    }
    const out = autoDisable({ store: env.store, candidateId: c.id, baselineSuccessRate: 0.9 });
    assert.equal(out.disabled, true);
    assert.equal(out.status.breached, true);
    assert.deepEqual(promotedCandidates({ store: env.store }), []);
    const history = candidateHistory({ store: env.store, candidateId: c.id });
    assert.equal(history[history.length - 1].to, 'rolled-back');
    assert.equal(history[history.length - 1].evidenceRef, 'canary:regression-breach');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
