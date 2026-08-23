import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StateStore, StateStoreError } from '../core/store.mjs';
import { AuditLog, redact, AuditLogError } from '../core/audit.mjs';

// ---------- StateStore: basic persistence ------------------------------

test('StateStore writes one JSONL file per table', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-store-'));
  try {
    const store = new StateStore({ root: tmp, workspaceId: 'w1' });
    store.saveWorkspace({ id: 'w1', manifestVersion: '1', manifestPath: '/tmp/w1/workspace.json' });
    store.saveObservation({ resource: 'node', version: '22.1.0', status: 'INSTALLED' });
    store.saveObservation({ resource: 'python', version: null, status: 'MISSING' });
    store.recordExecution({ plan: { workspace: 'w1', steps: [] }, report: { summary: { applied: 0 } }, mode: 'dry-run' });
    store.recordAudit({ kind: 'test.event', resource: 'node', message: 'hi' });

    assert.ok(fs.existsSync(path.join(tmp, 'w1', 'workspace.jsonl')));
    assert.ok(fs.existsSync(path.join(tmp, 'w1', 'resource.jsonl')));
    assert.ok(fs.existsSync(path.join(tmp, 'w1', 'execution.jsonl')));
    assert.ok(fs.existsSync(path.join(tmp, 'w1', 'audit.jsonl')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('StateStore records survive a fresh process (re-open and read)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-store-'));
  try {
    const store = StateStore.open('w1', { root: tmp });
    store.saveObservation({ resource: 'node', version: '22.1.0', status: 'INSTALLED' });
    store.saveObservation({ resource: 'node', version: '22.2.0', status: 'INSTALLED' });
    store.saveObservation({ resource: 'python', version: null, status: 'MISSING' });

    const reopened = StateStore.open('w1', { root: tmp });
    const nodeObservations = reopened.listObservations('node');
    assert.equal(nodeObservations.length, 2);
    assert.equal(nodeObservations[0].version, '22.1.0');
    assert.equal(nodeObservations[1].version, '22.2.0');
    const allResources = reopened.listObservations();
    assert.equal(allResources.length, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('StateStore rejects invalid workspace ids', () => {
  assert.throws(() => new StateStore({ workspaceId: '../escape' }), StateStoreError);
});

test('StateStore rejects invalid table names', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-store-'));
  try {
    const store = StateStore.open('w', { root: tmp });
    assert.throws(() => store._tablePath('../bad'), StateStoreError);
    assert.throws(() => store._tablePath('9bad'), StateStoreError);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('StateStore skips corrupt JSONL lines instead of throwing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-store-'));
  try {
    const store = StateStore.open('w', { root: tmp });
    fs.writeFileSync(path.join(tmp, 'w', 'resource.jsonl'),
      '{"resource":"node","version":"22"}\n{ this is broken\n{"resource":"python","version":"3.12"}\n'
    );
    const observations = store.listObservations();
    assert.equal(observations.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- redact() ----------------------------------------------------

test('redact replaces token / secret / password / key fields', () => {
  const input = {
    token: 'ghp_secret',
    password: 'hunter2',
    API_KEY: 'ak_secret',
    nested: { auth: 'bearer xxx', inner: { session: 'sess', ok: 'visible' } },
    list: [{ secret: 'plain' }, { token: 'plain2' }, { visible: 'ok' }],
  };
  const out = redact(input);
  assert.equal(out.token, '***REDACTED***');
  assert.equal(out.password, '***REDACTED***');
  assert.equal(out.API_KEY, '***REDACTED***');
  assert.equal(out.nested.auth, '***REDACTED***');
  assert.equal(out.nested.inner.session, '***REDACTED***');
  assert.equal(out.nested.inner.ok, 'visible');
  assert.equal(out.list[0].secret, '***REDACTED***');
  assert.equal(out.list[1].token, '***REDACTED***');
  assert.equal(out.list[2].visible, 'ok');
});

test('redact replaces { secret: NAME } references', () => {
  const out = redact({ env: { GH_TOKEN: { secret: 'GH_TOKEN' } } });
  assert.equal(out.env.GH_TOKEN, '***REDACTED***');
});

test('redact supports extra fields and does not mutate the input', () => {
  const input = { bearer: 'x', oauth: 'y', keep: 'z' };
  const out = redact(input, { fields: ['bearer', 'oauth'] });
  assert.equal(out.bearer, '***REDACTED***');
  assert.equal(out.oauth, '***REDACTED***');
  assert.equal(out.keep, 'z');
  assert.equal(input.bearer, 'x'); // not mutated
});

test('redact handles null, primitives, arrays, and cycles', () => {
  assert.equal(redact(null), null);
  assert.equal(redact(42), 42);
  assert.equal(redact('hello'), 'hello');
  const a = {};
  a.self = a;
  const out = redact(a);
  assert.equal(out.self, a);
});

// ---------- AuditLog ---------------------------------------------------

test('AuditLog records an event with a generated timestamp', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-audit-'));
  try {
    const log = new AuditLog({ workspaceId: 'w' });
    const written = log.record({ kind: 'test.event', resource: 'node' });
    assert.equal(written.kind, 'test.event');
    assert.ok(written.timestamp);
    // The store should be at the default root; that's fine — we just check
    // the in-memory record is shaped correctly.
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AuditLog rejects non-object events', () => {
  const log = new AuditLog({ workspaceId: 'w' });
  assert.throws(() => log.record(null), AuditLogError);
  assert.throws(() => log.record('event'), AuditLogError);
});

test('AuditLog.resourceObserved redacts the observed value', () => {
  const log = new AuditLog({ workspaceId: 'w' });
  const ev = log.resourceObserved('mcp', { version: '1', details: { token: 'ghp_secret' } });
  assert.equal(ev.observed.details.token, '***REDACTED***');
  assert.equal(ev.observed.version, '1');
});

test('AuditLog stores events via StateStore and they survive reopen', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-audit-'));
  try {
    const store = new StateStore({ root: tmp, workspaceId: 'w' });
    const log = new AuditLog({ workspaceId: 'w', store });
    log.stepApplied({ resource: 'node', action: 'INSTALL', before: null, after: '22', status: 'APPLIED' });
    log.stepApplied({ resource: 'python', action: 'INSTALL', before: null, after: '3.12', status: 'APPLIED' });

    const reopened = new AuditLog({ workspaceId: 'w', store: new StateStore({ root: tmp, workspaceId: 'w' }) });
    const events = reopened._store.listAudit();
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'step.applied');
    assert.equal(events[0].resource, 'node');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AuditLog.stepApplied redacts error objects', () => {
  const log = new AuditLog({ workspaceId: 'w' });
  const ev = log.stepApplied({
    resource: 'mcp',
    action: 'INSTALL',
    before: null,
    after: '1',
    status: 'FAILED',
    error: { code: 'X', message: 'failed', token: 'ghp_secret' },
  });
  assert.equal(ev.error.code, 'X');
  assert.equal(ev.error.token, '***REDACTED***');
});

test('Secret values never leak through any AuditLog convenience wrapper', () => {
  const log = new AuditLog({ workspaceId: 'w' });
  const r1 = log.stepApplied({ resource: 'mcp', action: 'INSTALL', before: null, after: '1', status: 'APPLIED', details: { token: 'ghp_secret' } });
  const r2 = log.executionFinished({ summary: {}, changed: true, error: { password: 'hunter2' } });
  const r3 = log.verificationRun({ resource: 'node', result: 'fail', details: { api_key: 'ak_secret' } });
  const all = [r1, r2, r3].map((e) => JSON.stringify(e)).join('\n');
  assert.doesNotMatch(all, /ghp_secret/);
  assert.doesNotMatch(all, /hunter2/);
  assert.doesNotMatch(all, /ak_secret/);
});

test('redact handles Map / Set / Buffer / Date / Error', () => {
  // Map: 'token' key triggers redaction; Buffer value is summarized.
  const m = new Map();
  m.set('token', { secret: 'GH_TOKEN' });
  m.set('visible', Buffer.from('visible-bytes'));
  // Set: items containing 'token' field are redacted.
  const s = new Set();
  s.add({ token: 'ghp_secret_inside' });
  s.add('plain');
  const d = new Date('2026-08-23T00:00:00Z');
  const e = new Error('failed because token=ghp_secret');
  const out = redact({ map: m, set: s, date: d, err: e });
  // Map: 'token' key REDACTED, value {secret: NAME} REDACTED.
  assert.equal(out.map.get('***REDACTED***'), '***REDACTED***');
  const visibleEntry = out.map.get('visible');
  assert.match(visibleEntry, /^\<Buffer length=\d+\>$/);
  // Set: item containing token field has its token REDACTED.
  const setItems = [...out.set];
  assert.ok(setItems.some((v) => v.token === '***REDACTED***'));
  // Date: ISO string preserved.
  assert.equal(out.date, '2026-08-23T00:00:00.000Z');
  // Error: message + stack REDACTED; name preserved.
  assert.equal(out.err.name, 'Error');
  assert.equal(out.err.message, '***REDACTED***');
  assert.equal(out.err.stack, '***REDACTED***');
});

test('redact never persists Buffer bytes or Error stack with secrets', () => {
  const out = redact({ raw: Buffer.from('ghp_secret_bytes'), err: new Error('boom: ghp_secret') });
  const dumped = JSON.stringify(out);
  assert.doesNotMatch(dumped, /ghp_secret_bytes/);
  assert.doesNotMatch(dumped, /boom: ghp_secret/);
});