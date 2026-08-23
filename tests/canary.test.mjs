// Level 5 Task 5: approval, canary and rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore } from '../core/store.mjs';
import { proposeCandidate, transitionCandidate, candidateHistory } from '../core/candidates.mjs';
import {
  approve, promote, canarySlice, reportCanaryResult, canaryStatus, autoDisable, rollback,
  canaryRuns, promotedCandidates, CanaryError,
} from '../core/canary.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-canary-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  return { tmp, store };
}

function seedPromoted(env, id = 'cand-1') {
  proposeCandidate({
    id, version: '1.0.0', scope: 'standard-development:1.0.0', rationale: 'r', evidenceLinks: ['e'],
    expectedEffect: 'e', rollbackTarget: 'routing-default',
    rule: { kind: 'routing', params: { agentWeightOverrides: { alice: 1.5 } } },
    store: env.store, actor: 'reflection-engine',
  });
  transitionCandidate({ store: env.store, candidateId: id, to: 'evaluated', evidenceRef: 'bench:1', actor: 'benchmark' });
  approve({ store: env.store, candidateId: id, actor: 'alice' });
  return promote({ store: env.store, candidateId: id, actor: 'control-plane' });
}

test('promotion requires an explicit human approval record', () => {
  const env = makeEnv();
  try {
    proposeCandidate({
      id: 'cand-x', version: '1.0.0', scope: 's', rationale: 'r', evidenceLinks: ['e'],
      expectedEffect: 'e', rollbackTarget: 't', store: env.store,
      rule: { kind: 'routing', params: {} },
    });
    transitionCandidate({ store: env.store, candidateId: 'cand-x', to: 'evaluated', evidenceRef: 'bench:1', actor: 'benchmark' });
    assert.throws(() => promote({ store: env.store, candidateId: 'cand-x' }), (err) => err instanceof CanaryError && err.code === 'CANARY_APPROVAL_REQUIRED');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('full lifecycle: propose -> evaluate -> approve -> promote', () => {
  const env = makeEnv();
  try {
    const t = seedPromoted(env);
    assert.equal(t.status, 'promoted');
    assert.deepEqual(promotedCandidates({ store: env.store }).map((c) => c.id), ['cand-1']);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('canary slice selects at most ~10% of runs and is deterministic', () => {
  const env = makeEnv();
  try {
    const selected = [];
    for (let i = 0; i < 200; i += 1) {
      if (canarySlice({ store: env.store, candidateId: 'cand-1', runId: `run-${i}` })) selected.push(i);
    }
    assert.ok(selected.length / 200 <= 0.2, `selected ${selected.length}/200`);
    assert.ok(selected.length / 200 >= 0.02, `selected ${selected.length}/200`);
    // Deterministic: same runId hashes the same way.
    assert.equal(canarySlice({ store: env.store, candidateId: 'cand-1', runId: 'run-5' }), canaryRuns({ store: env.store, candidateId: 'cand-1' }).find((r) => r.runId === 'run-5').selected);
    assert.ok(canaryRuns({ store: env.store, candidateId: 'cand-1' }).length >= 200);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('a canary regression breach auto-disables the candidate', () => {
  const env = makeEnv();
  try {
    seedPromoted(env, 'cand-regress');
    // 6 results, only 2 succeed -> 0.333 vs baseline 0.9 -> breach (0.567 >= 0.1).
    for (let i = 0; i < 6; i += 1) {
      reportCanaryResult({ store: env.store, candidateId: 'cand-regress', runId: `r-${i}`, success: i < 2 });
    }
    const before = canaryStatus({ store: env.store, candidateId: 'cand-regress', baselineSuccessRate: 0.9 });
    assert.equal(before.breached, true);
    const out = autoDisable({ store: env.store, candidateId: 'cand-regress', baselineSuccessRate: 0.9 });
    assert.equal(out.disabled, true);
    // Candidate is no longer promoted.
    assert.deepEqual(promotedCandidates({ store: env.store }).map((c) => c.id), []);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('no breach below the threshold keeps the candidate promoted', () => {
  const env = makeEnv();
  try {
    seedPromoted(env, 'cand-ok');
    for (let i = 0; i < 8; i += 1) {
      reportCanaryResult({ store: env.store, candidateId: 'cand-ok', runId: `r-${i}`, success: true });
    }
    const out = autoDisable({ store: env.store, candidateId: 'cand-ok', baselineSuccessRate: 0.9 });
    assert.equal(out.disabled, false);
    assert.deepEqual(promotedCandidates({ store: env.store }).map((c) => c.id), ['cand-ok']);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('rollback restores the previous version target and keeps history intact', () => {
  const env = makeEnv();
  try {
    seedPromoted(env, 'cand-roll');
    const before = candidateHistory({ store: env.store, candidateId: 'cand-roll' }).length;
    const out = rollback({ store: env.store, candidateId: 'cand-roll', actor: 'alice' });
    assert.equal(out.rollbackTarget, 'routing-default');
    assert.equal(out.previousVersion, 'routing-default');
    assert.equal(out.transition.status, 'rolled-back');
    const after = candidateHistory({ store: env.store, candidateId: 'cand-roll' });
    assert.equal(after.length, before + 1, 'rollback appends history; nothing is deleted');
    assert.equal(after[after.length - 1].to, 'rolled-back');
    // Rolling back a non-promoted candidate is rejected.
    assert.throws(() => rollback({ store: env.store, candidateId: 'cand-roll' }), (err) => err.code === 'CANARY_ROLLBACK_STATUS_INVALID');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('canarySlice rejects an invalid fraction', () => {
  const env = makeEnv();
  try {
    assert.throws(() => canarySlice({ store: env.store, candidateId: 'c', runId: 'r', maxFraction: 0 }), (err) => err.code === 'CANARY_FRACTION_INVALID');
    assert.throws(() => canarySlice({ store: env.store, candidateId: 'c', runId: 'r', maxFraction: 2 }), (err) => err.code === 'CANARY_FRACTION_INVALID');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
