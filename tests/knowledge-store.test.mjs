// Level 3 Task 6: knowledge ingestion with retention policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore } from '../core/store.mjs';
import { createKnowledgeStore, KnowledgeStoreError } from '../core/knowledge-store.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-know-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  const objectsRoot = path.join(tmp, 'objects');
  const k = createKnowledgeStore({ store, objectsRoot });
  return { tmp, store, objectsRoot, k };
}

test('ingest writes content-addressed object and metadata row without content', () => {
  const env = makeEnv();
  try {
    const row = env.k.ingest({ sourcePath: 'docs/architecture.md', kind: 'markdown', scope: 'docs/', content: '# Architecture\nDesign notes.\n' });
    assert.equal(row.contentHash.length, 64);
    const objectFile = path.join(env.objectsRoot, row.contentHash);
    assert.ok(fs.existsSync(objectFile));
    assert.equal(fs.readFileSync(objectFile, 'utf8'), '# Architecture\nDesign notes.\n');
    const rows = env.store.readRows('knowledge_index');
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0].content, 'undefined', 'index rows must not carry content');
    assert.equal(rows[0].sourcePath, 'docs/architecture.md');
    assert.equal(rows[0].scope, 'docs/');
    assert.equal(rows[0].status, 'ACTIVE');
    assert.ok(rows[0].byteCount > 0);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('identical content is deduplicated: no second object file', () => {
  const env = makeEnv();
  try {
    const a = env.k.ingest({ sourcePath: 'a.md', kind: 'markdown', scope: 'docs/', content: 'same text' });
    const b = env.k.ingest({ sourcePath: 'b.md', kind: 'markdown', scope: 'docs/', content: 'same text' });
    assert.equal(a.contentHash, b.contentHash);
    const objectFiles = fs.readdirSync(env.objectsRoot);
    assert.equal(objectFiles.length, 1, 'identical content must share one object file');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('re-ingesting a sourcePath appends a superseding row; list shows the latest', () => {
  const env = makeEnv();
  try {
    env.k.ingest({ sourcePath: 'notes.md', kind: 'markdown', scope: 'docs/', content: 'v1' });
    const v2 = env.k.ingest({ sourcePath: 'notes.md', kind: 'markdown', scope: 'docs/', content: 'v2 longer' });
    const rows = env.store.readRows('knowledge_index');
    assert.equal(rows.length, 2, 'index is append-only');
    assert.ok(rows[1].supersedes === rows[0]._id, 'new row supersedes the old');
    const listed = env.k.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].contentHash, v2.contentHash);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('removeIndexRow marks DELETED append-only; purge removes unreferenced objects', () => {
  const env = makeEnv();
  try {
    const a = env.k.ingest({ sourcePath: 'keep.md', kind: 'markdown', scope: 'docs/', content: 'keep me' });
    const b = env.k.ingest({ sourcePath: 'drop.md', kind: 'markdown', scope: 'docs/', content: 'drop me' });
    const res = env.k.removeIndexRow({ sourcePath: 'drop.md' });
    assert.equal(res.removed, true);
    assert.deepEqual(env.k.list().map((r) => r.sourcePath), ['keep.md']);
    // Object files for both still exist until purge.
    assert.ok(fs.existsSync(path.join(env.objectsRoot, a.contentHash)));
    assert.ok(fs.existsSync(path.join(env.objectsRoot, b.contentHash)));
    const purge = env.k.purgeUnreferenced();
    assert.deepEqual(purge.removed, [b.contentHash]);
    assert.equal(purge.retained, 1);
    assert.ok(!fs.existsSync(path.join(env.objectsRoot, b.contentHash)));
    assert.ok(fs.existsSync(path.join(env.objectsRoot, a.contentHash)));
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('ingestDirectory ingests markdown first and records relative paths under scope', () => {
  const env = makeEnv();
  try {
    const src = path.join(env.tmp, 'repo');
    fs.mkdirSync(path.join(src, 'src'), { recursive: true });
    fs.mkdirSync(path.join(src, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(src, 'README.md'), '# Readme\n', 'utf8');
    fs.writeFileSync(path.join(src, 'src', 'app.js'), 'export const x = 1;\n', 'utf8');
    fs.writeFileSync(path.join(src, 'docs', 'design.md'), '# Design\n', 'utf8');
    fs.writeFileSync(path.join(src, 'src', 'blob.bin'), Buffer.from([0, 1, 2]));
    const out = env.k.ingestDirectory({ dir: src, scope: 'repo/' });
    assert.equal(out.ingested.length, 3);
    assert.equal(out.skipped.length, 1);
    const paths = out.ingested.map((r) => r.sourcePath);
    const kinds = out.ingested.map((r) => r.kind);
    // Markdown files must be ingested before code files; order is deterministic.
    assert.deepEqual(kinds.slice(0, 2), ['markdown', 'markdown']);
    assert.equal(kinds[2], 'code');
    assert.deepEqual(new Set(paths), new Set(['repo/README.md', 'repo/docs/design.md', 'repo/src/app.js']));
    const again = env.k.ingestDirectory({ dir: src, scope: 'repo/' });
    assert.deepEqual(again.ingested.map((r) => r.sourcePath), paths, 're-ingestion order is stable');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('invalid scopes are rejected', () => {
  const env = makeEnv();
  try {
    assert.throws(
      () => env.k.ingest({ sourcePath: 'x.md', scope: '/abs', content: 'x' }),
      (err) => err instanceof KnowledgeStoreError && err.code === 'KNOWLEDGE_SCOPE_INVALID',
    );
    assert.throws(
      () => env.k.ingest({ sourcePath: 'x.md', scope: '../escape', content: 'x' }),
      (err) => err instanceof KnowledgeStoreError && err.code === 'KNOWLEDGE_SCOPE_INVALID',
    );
    assert.throws(
      () => env.k.ingest({ sourcePath: 'x.md', scope: 'ok/', content: 'x', retention: 'never' }),
      (err) => err instanceof KnowledgeStoreError && err.code === 'KNOWLEDGE_RETENTION_INVALID',
    );
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('list filters by scope prefix', () => {
  const env = makeEnv();
  try {
    env.k.ingest({ sourcePath: 'src/a.js', kind: 'code', scope: 'src/', content: 'a' });
    env.k.ingest({ sourcePath: 'docs/b.md', kind: 'markdown', scope: 'docs/', content: 'b' });
    const src = env.k.list({ scope: 'src/' });
    assert.deepEqual(src.map((r) => r.sourcePath), ['src/a.js']);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
