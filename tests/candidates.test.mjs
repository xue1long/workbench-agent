// Level 5 Task 3: structured candidate lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore } from '../core/store.mjs';
import {
  proposeCandidate, transitionCandidate, candidateHistory, activeCandidates, applyCandidateRule, CandidateError,
} from '../core/candidates.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cand-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  return { tmp, store };
}

function proposal(store, overrides = {}) {
  return proposeCandidate({
    id: 'cand-1', version: '1.0.0', scope: 'standard-development:1.0.0',
    rationale: 'worst runs used bob; best used alice',
    evidenceLinks: ['traj:r-1', 'traj:r-2'],
    expectedEffect: '+5pp success rate',
    rollbackTarget: 'routing-default',
    rule: { kind: 'routing', params: { agentWeightOverrides: { alice: 1.5 } } },
    store, actor: 'reflection-engine',
    ...overrides,
  });
}

test('proposeCandidate validates and creates a candidate with history', () => {
  const env = makeEnv();
  try {
    const c = proposal(env.store);
    assert.equal(c.status, 'proposed');
    assert.equal(c.createdBy, 'reflection-engine');
    assert.equal(c.rollbackTarget, 'routing-default');
    const history = candidateHistory({ store: env.store, candidateId: 'cand-1' });
    assert.equal(history.length, 1);
    assert.equal(history[0].to, 'proposed');
    assert.equal(history[0].actor, 'reflection-engine');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('proposal validation rejects missing fields and invalid rules', () => {
  const env = makeEnv();
  try {
    assert.throws(() => proposal(env.store, { scope: '' }), (err) => err.code === 'CANDIDATE_SCOPE_INVALID');
    assert.throws(() => proposal(env.store, { evidenceLinks: [] }), (err) => err.code === 'CANDIDATE_EVIDENCE_INVALID');
    assert.throws(() => proposal(env.store, { rollbackTarget: '' }), (err) => err.code === 'CANDIDATE_ROLLBACK_INVALID');
    assert.throws(() => proposal(env.store, { rule: { kind: 'magic', params: {} } }), (err) => err.code === 'CANDIDATE_RULE_INVALID');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('lifecycle transitions are legal only in order; history is append-only', () => {
  const env = makeEnv();
  try {
    proposal(env.store);
    // Illegal: proposed -> promoted directly.
    assert.throws(() => transitionCandidate({ store: env.store, candidateId: 'cand-1', to: 'promoted' }), (err) => err.code === 'CANDIDATE_TRANSITION_INVALID');
    const t1 = transitionCandidate({ store: env.store, candidateId: 'cand-1', to: 'evaluated', evidenceRef: 'bench:1', actor: 'benchmark' });
    assert.equal(t1.status, 'evaluated');
    const t2 = transitionCandidate({ store: env.store, candidateId: 'cand-1', to: 'approved', evidenceRef: 'human:alice', actor: 'alice' });
    assert.equal(t2.status, 'approved');
    const t3 = transitionCandidate({ store: env.store, candidateId: 'cand-1', to: 'promoted', evidenceRef: 'human:alice', actor: 'alice' });
    assert.equal(t3.status, 'promoted');
    const t4 = transitionCandidate({ store: env.store, candidateId: 'cand-1', to: 'rolled-back', evidenceRef: 'canary:breach', actor: 'canary' });
    assert.equal(t4.status, 'rolled-back');
    // After rolled-back, no further transitions.
    assert.throws(() => transitionCandidate({ store: env.store, candidateId: 'cand-1', to: 'evaluated' }), (err) => err.code === 'CANDIDATE_TRANSITION_INVALID');
    const history = candidateHistory({ store: env.store, candidateId: 'cand-1' });
    assert.equal(history.length, 5);
    assert.deepEqual(history.map((h) => h.to), ['proposed', 'evaluated', 'approved', 'promoted', 'rolled-back']);
    assert.equal(history[2].actor, 'alice');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('reject paths and activeCandidates', () => {
  const env = makeEnv();
  try {
    proposal(env.store, { id: 'cand-bad' });
    transitionCandidate({ store: env.store, candidateId: 'cand-bad', to: 'rejected', evidenceRef: 'bench:fail', actor: 'benchmark' });
    const active = activeCandidates({ store: env.store });
    assert.equal(active.length, 0, 'rejected candidate is not active');
    proposal(env.store, { id: 'cand-live' });
    assert.deepEqual(activeCandidates({ store: env.store }).map((c) => c.id), ['cand-live']);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('applyCandidateRule applies only promoted candidates per kind', () => {
  const env = makeEnv();
  try {
    const proposed = proposal(env.store, { id: 'cand-x', rule: { kind: 'workflow', params: { templateVersion: '2.0.0' } } });
    const notApplied = applyCandidateRule(proposed);
    assert.equal(notApplied.applied, false);
    transitionCandidate({ store: env.store, candidateId: 'cand-x', to: 'evaluated' });
    transitionCandidate({ store: env.store, candidateId: 'cand-x', to: 'approved' });
    const promoted = transitionCandidate({ store: env.store, candidateId: 'cand-x', to: 'promoted' });
    const applied = applyCandidateRule({ ...proposed, status: 'promoted' });
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.result, { workflow: { templateVersion: '2.0.0' } });
    assert.equal(promoted.status, 'promoted');
    // meta-skill kind
    const ms = proposeCandidate({
      id: 'cand-ms', version: '1.0.0', scope: 'x', rationale: 'r', evidenceLinks: ['e'],
      expectedEffect: 'e', rollbackTarget: 't', store: env.store,
      rule: { kind: 'meta-skill', params: { skillId: 'router-v2', config: { weight: 0.9 } } },
    });
    assert.deepEqual(applyCandidateRule({ ...ms, status: 'promoted' }).result, { metaSkill: { skillId: 'router-v2', config: { weight: 0.9 } } });
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('duplicate candidate id+version is rejected', () => {
  const env = makeEnv();
  try {
    proposal(env.store);
    assert.throws(() => proposal(env.store), (err) => err.code === 'CANDIDATE_EXISTS');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
