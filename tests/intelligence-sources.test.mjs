// Level 6 Tasks 1-2: source registration + idempotent ingestion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore } from '../core/store.mjs';
import { registerSource, storeContent, sourceById, listSources, SourceError } from '../core/intelligence/sources.mjs';
import { ingestSource, sourceVersions, extractionAt } from '../core/intelligence/ingest.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-int-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  const objectsRoot = path.join(tmp, 'objects');
  return { tmp, store, objectsRoot };
}

function sampleSource(overrides = {}) {
  return {
    id: 'paper-1', kind: 'paper', canonicalUrl: 'https://arxiv.org/abs/2501.00001',
    retrievedAt: '2026-08-23T00:00:00.000Z', tier: 1,
    license: 'CC-BY-4.0', terms: 'ok', retentionClass: 'keep', permission: 'granted',
    doi: '10.1234/arXiv.2501.00001',
    ...overrides,
  };
}

test('registerSource validates required fields and rejects bad input', () => {
  const env = makeEnv();
  try {
    // An empty object fails id validation first; the rest of the matrix exercises one invalid field each.
    assert.throws(() => registerSource({ store: env.store, source: {} }), (err) => err.code === 'SOURCE_ID_INVALID');
    assert.throws(() => registerSource({ store: env.store, source: sampleSource({ id: '' }) }), (err) => err.code === 'SOURCE_ID_INVALID');
    assert.throws(() => registerSource({ store: env.store, source: sampleSource({ kind: 'podcast' }) }), (err) => err.code === 'SOURCE_KIND_INVALID');
    assert.throws(() => registerSource({ store: env.store, source: sampleSource({ canonicalUrl: '' }) }), (err) => err.code === 'SOURCE_URL_INVALID');
    assert.throws(() => registerSource({ store: env.store, source: sampleSource({ retrievedAt: 'today' }) }), (err) => err.code === 'SOURCE_RETRIEVED_AT_INVALID');
    assert.throws(() => registerSource({ store: env.store, source: sampleSource({ tier: 5 }) }), (err) => err.code === 'SOURCE_TIER_INVALID');
    assert.throws(() => registerSource({ store: env.store, source: sampleSource({ retentionClass: 'forever' }) }), (err) => err.code === 'SOURCE_RETENTION_INVALID');
    assert.throws(() => registerSource({ store: env.store, source: sampleSource({ permission: 'maybe' }) }), (err) => err.code === 'SOURCE_PERMISSION_INVALID');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('canonicalUrl is immutable for a given source id', () => {
  const env = makeEnv();
  try {
    registerSource({ store: env.store, source: sampleSource() });
    assert.throws(
      () => registerSource({ store: env.store, source: sampleSource({ canonicalUrl: 'https://other' }) }),
      (err) => err.code === 'SOURCE_URL_IMMUTABLE',
    );
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('storeContent keeps metadata-only when rights are missing or link-only', () => {
  const env = makeEnv();
  try {
    const src = sampleSource({ permission: 'unknown', license: null, retentionClass: 'link-only' });
    registerSource({ store: env.store, source: src });
    const meta = storeContent({ store: env.store, objectsRoot: env.objectsRoot, sourceId: src.id, content: 'body' });
    assert.equal(meta.bodyStored, false);
    assert.equal(env.store.readRows('intelligence_source_content').length, 1);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('storeContent stores body when license/terms/permission are recorded and retention allows', () => {
  const env = makeEnv();
  try {
    registerSource({ store: env.store, source: sampleSource() });
    const row = storeContent({ store: env.store, objectsRoot: env.objectsRoot, sourceId: sampleSource().id, content: 'arXiv paper text' });
    assert.equal(row.bodyStored, true);
    assert.ok(fs.existsSync(row.objectPath));
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('listSources dedupes by id and filters by tier', () => {
  const env = makeEnv();
  try {
    registerSource({ store: env.store, source: sampleSource() });
    registerSource({ store: env.store, source: sampleSource({ id: 'p2', tier: 3, doi: '10.1234/d' }) });
    assert.equal(listSources({ store: env.store }).length, 2);
    assert.equal(listSources({ store: env.store, tier: 1 }).length, 1);
    assert.equal(listSources({ store: env.store, tier: 3 }).length, 1);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('ingestSource is idempotent: same content twice returns unchanged with no new rows', () => {
  const env = makeEnv();
  try {
    const src = sampleSource();
    registerSource({ store: env.store, source: src });
    const first = ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: src, content: 'same body' });
    assert.equal(first.status, 'created');
    assert.equal(first.version, 1);
    const second = ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: src, content: 'same body' });
    assert.equal(second.status, 'unchanged');
    assert.equal(second.version, 1);
    assert.equal(env.store.readRows('intelligence_ingestion').length, 2);
    assert.equal(env.store.readRows('intelligence_extraction').length, 1, 'extraction rows only on real changes');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('ingestSource updates the version and preserves the old extraction', () => {
  const env = makeEnv();
  try {
    const src = sampleSource();
    registerSource({ store: env.store, source: src });
    const first = ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: src, content: 'v1 body', extracted: { problem: 'p1' } });
    assert.equal(first.status, 'created');
    const second = ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: src, content: 'v2 body', extracted: { problem: 'p2' } });
    assert.equal(second.status, 'updated');
    assert.equal(second.version, 2);
    assert.equal(second.previousVersion, 1);
    assert.deepEqual(extractionAt({ store: env.store, sourceId: src.id, version: 1 }).extracted, { problem: 'p1' }, 'v1 preserved');
    assert.deepEqual(extractionAt({ store: env.store, sourceId: src.id, version: 2 }).extracted, { problem: 'p2' });
    const versions = sourceVersions({ store: env.store, sourceId: src.id });
    assert.deepEqual(versions.map((v) => v.status), ['created', 'updated']);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('ingestSource deduplicates by DOI across sources', () => {
  const env = makeEnv();
  try {
    const a = sampleSource({ id: 'paper-a', doi: '10.1234/dedupe', canonicalUrl: 'https://a' });
    const b = sampleSource({ id: 'paper-b', doi: '10.1234/dedupe', canonicalUrl: 'https://b' });
    registerSource({ store: env.store, source: a });
    registerSource({ store: env.store, source: b });
    const first = ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: a, content: 'c1' });
    assert.equal(first.status, 'created');
    const second = ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: b, content: 'c1' });
    assert.equal(second.status, 'unchanged', 'same DOI + same content = idempotent across sources');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('ingestSource requires a registered source', () => {
  const env = makeEnv();
  try {
    assert.throws(() => ingestSource({ store: env.store, objectsRoot: env.objectsRoot, source: sampleSource(), content: 'x' }), (err) => err.code === 'INGEST_SOURCE_NOT_REGISTERED');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('storeContent rejects non-string content when body storage is allowed', () => {
  const env = makeEnv();
  try {
    registerSource({ store: env.store, source: sampleSource() });
    assert.throws(() => storeContent({ store: env.store, objectsRoot: env.objectsRoot, sourceId: 'paper-1', content: null }), (err) => err.code === 'SOURCE_CONTENT_INVALID');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
