// Level 3 Task 9: durable project memory — reviewed decisions and verified
// artifacts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore } from '../core/store.mjs';
import { createProjectMemory, ProjectMemoryError } from '../core/project-memory.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mem-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  const objectsRoot = path.join(tmp, 'objects');
  const mem = createProjectMemory({ store, objectsRoot });
  return { tmp, store, objectsRoot, mem };
}

test('reviewed decision is saved with content on disk and metadata rows', () => {
  const env = makeEnv();
  try {
    const saved = env.mem.saveDecision({
      runId: 'run-1',
      decision: {
        kind: 'decision',
        reviewed: true,
        reviewerEvidenceRef: 'ev-review-1',
        scope: 'src/',
        source: 'oauth-flow',
        content: '# Decision: use authorization-code flow\nUse the authorization code flow with rotating refresh tokens.',
      },
    });
    assert.equal(saved.type, 'decision');
    assert.ok(fs.existsSync(path.join(env.objectsRoot, saved.contentHash)));
    const rows = env.store.readRows('project_memory');
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0].content, 'undefined', 'rows must not carry content');
    assert.equal(rows[0].reviewerEvidenceRef, 'ev-review-1');
    assert.equal(rows[0].status, 'ACTIVE');
    const listed = env.mem.query({ scope: 'src/' });
    assert.equal(listed.length, 1);
    assert.match(env.mem.content(listed[0]), /authorization-code flow/);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('unreviewed decisions are rejected', () => {
  const env = makeEnv();
  try {
    assert.throws(
      () => env.mem.saveDecision({ runId: 'r', decision: { kind: 'decision', reviewed: false, content: 'x' } }),
      (err) => err instanceof ProjectMemoryError && err.code === 'PROJECT_MEMORY_UNREVIEWED',
    );
    assert.throws(
      () => env.mem.saveDecision({ runId: 'r', decision: { kind: 'decision', reviewed: true, content: 'x' } }),
      (err) => err instanceof ProjectMemoryError && err.code === 'PROJECT_MEMORY_NO_REVIEW_EVIDENCE',
    );
    assert.equal(env.store.readRows('project_memory').length, 0);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('unverified agent claims are rejected; verified artifacts are saved with provenance', () => {
  const env = makeEnv();
  try {
    // A raw EvidenceClaim has no verifier_version — it is untrusted.
    assert.throws(
      () => env.mem.saveVerifiedArtifact({ runId: 'r', artifact: { kind: 'artifact', evidenceKind: 'test', content: 'claim' } }),
      (err) => err instanceof ProjectMemoryError && err.code === 'PROJECT_MEMORY_UNVERIFIED',
    );
    assert.throws(
      () => env.mem.saveVerifiedArtifact({ runId: 'r', artifact: { verifierVersion: '1.0.0', evidenceKind: 'magic', content: 'x' } }),
      (err) => err instanceof ProjectMemoryError && err.code === 'PROJECT_MEMORY_EVIDENCE_KIND_INVALID',
    );
    const saved = env.mem.saveVerifiedArtifact({
      runId: 'run-1',
      artifact: {
        kind: 'test-report',
        evidenceKind: 'test',
        verifierVersion: '2.1.0',
        scope: 'tests/',
        source: 'oauth.test',
        content: 'oauth tests: 12 passed, 0 failed',
      },
    });
    assert.equal(saved.type, 'artifact');
    assert.equal(saved.verifierVersion, '2.1.0');
    assert.equal(saved.evidenceKind, 'test');
    const listed = env.mem.query({ scope: 'tests/' });
    assert.equal(listed.length, 1);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('corrections append superseding rows; history is preserved', () => {
  const env = makeEnv();
  try {
    const v1 = env.mem.saveDecision({
      runId: 'r1',
      decision: { kind: 'decision', reviewed: true, reviewerEvidenceRef: 'ev1', source: 'strategy', content: 'v1' },
    });
    const v2 = env.mem.saveDecision({
      runId: 'r2',
      decision: { kind: 'decision', reviewed: true, reviewerEvidenceRef: 'ev2', source: 'strategy', content: 'v2 corrected' },
    });
    const rows = env.store.readRows('project_memory');
    assert.equal(rows.length, 2, 'append-only');
    assert.equal(rows[1].supersedes, v1._id);
    const active = env.mem.query({});
    assert.equal(active.length, 1);
    assert.equal(active[0]._id, v2._id);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('memoryIndex groups active entries by source with provenance', () => {
  const env = makeEnv();
  try {
    env.mem.saveDecision({
      runId: 'r',
      decision: { kind: 'decision', reviewed: true, reviewerEvidenceRef: 'ev', scope: 'src/', source: 'routing', content: 'use deterministic scoring' },
    });
    const idx = env.mem.memoryIndex({ scope: 'src/' });
    assert.deepEqual(Object.keys(idx), ['routing']);
    assert.equal(idx.routing.type, 'decision');
    assert.equal(idx.routing.reviewed, true);
    assert.equal(typeof idx.routing.contentHash, 'string');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
