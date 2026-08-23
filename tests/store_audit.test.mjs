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

// ---------- Level 2 Task 2: orchestration projection wrappers ----------
//
// Workbench observability must be digest-only for raw prompt / context /
// stdout / stderr fields. The audit table remains the single projection; we
// add uppercase orchestration event types and a filterable listAudit.

test('AuditLog.taskCreated emits an uppercase type with run identity', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l2-audit-'));
  try {
    const store = new StateStore({ root: tmp, workspaceId: 'w' });
    const log = new AuditLog({ workspaceId: 'w', store });
    const ev = log.taskCreated({ taskId: 't1', runId: 'r1', goal: 'ship it' });
    assert.equal(ev.type, 'TASK_CREATED');
    assert.equal(ev.taskId, 't1');
    assert.equal(ev.runId, 'r1');
    assert.equal(ev.goal, 'ship it');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AuditLog orchestration wrappers map onto the frozen event vocabulary', () => {
  const log = new AuditLog({ workspaceId: 'w' });
  const mapping = [
    [log.taskPlanned({ taskId: 't', runId: 'r', nodeIds: ['a'] }), 'TASK_PLANNED'],
    [log.agentSelected({ taskId: 't', runId: 'r', nodeId: 'a', agentId: 'codex', score: 0.5, reasons: ['capability'] }), 'AGENT_SELECTED'],
    [log.nodeStarted({ taskId: 't', runId: 'r', nodeId: 'a' }), 'AGENT_STARTED'],
    [log.toolCalled({ taskId: 't', runId: 'r', nodeId: 'a', tool: 'git', argumentsDigest: { sha256: 'abc', bytes: 3 } }), 'TOOL_CALLED'],
    [log.nodeFinished({ taskId: 't', runId: 'r', nodeId: 'a', status: 'APPLIED', durationMs: 12 }), 'NODE_EXECUTION_SUCCEEDED'],
    [log.nodeRetried({ taskId: 't', runId: 'r', nodeId: 'a', attempt: 2 }), 'TASK_RETRIED'],
    [log.nodeFailed({ taskId: 't', runId: 'r', nodeId: 'a', reason: 'verification failed' }), 'TASK_FAILED'],
    [log.changeSetCreated({ taskId: 't', runId: 'r', patchSha256: 'h', changedFiles: ['a.py'] }), 'CHANGESET_CREATED'],
    [log.actionProposed({ taskId: 't', runId: 'r', actionId: 'act-1', files: ['a.py'] }), 'ACTION_PROPOSED'],
    [log.runtimeDecided({ taskId: 't', runId: 'r', sessionId: 's', decision: { kind: 'finish' }, integrity: { valid: true } }), 'RUNTIME_DECIDED'],
    [log.taskHalted({ taskId: 't', runId: 'r', reason: 'budget exceeded' }), 'TASK_HALTED'],
    [log.taskQuarantined({ taskId: 't', runId: 'r', reason: 'event store corrupt' }), 'TASK_QUARANTINED'],
    [log.planRevised({ taskId: 't', runId: 'r', reason: 'reviewer correction', graphRevision: 2 }), 'PLAN_REVISED'],
  ];
  for (const [event, type] of mapping) {
    assert.equal(event.type, type, `wrapper must produce ${type}, got ${event.type}`);
  }
});

test('AuditLog.nodeStarted redacts context into a digest and keeps run identity', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l2-audit-'));
  try {
    const store = new StateStore({ root: tmp, workspaceId: 'w' });
    const log = new AuditLog({ workspaceId: 'w', store });
    const ev = log.nodeStarted({
      taskId: 't1',
      runId: 'r1',
      nodeId: 'n1',
      context: { token: 'do-not-store', free: 'ok' },
    });
    assert.equal(ev.runId, 'r1');
    assert.equal(ev.context, undefined);
    assert.match(ev.contextDigest.sha256, /^[a-f0-9]{64}$/);
    assert.ok(ev.contextDigest.bytes > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AuditLog redacts prompt / context / stdout / stderr fields into digests', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l2-audit-'));
  try {
    const store = new StateStore({ root: tmp, workspaceId: 'w' });
    const log = new AuditLog({ workspaceId: 'w', store });
    log.record({
      type: 'RAW_FIELDS_TEST',
      taskId: 't1',
      runId: 'r1',
      prompt: 'system: be careful',
      context: { token: 'leak' },
      stdout: 'hello world\n',
      stderr: 'warning: deprecated\n',
      summary: 'ok',
    });
    const stored = store.listAudit();
    const last = stored[stored.length - 1];
    assert.equal(last.prompt, undefined);
    assert.equal(last.context, undefined);
    assert.equal(last.stdout, undefined);
    assert.equal(last.stderr, undefined);
    assert.match(last.promptDigest.sha256, /^[a-f0-9]{64}$/);
    assert.match(last.contextDigest.sha256, /^[a-f0-9]{64}$/);
    assert.match(last.stdoutDigest.sha256, /^[a-f0-9]{64}$/);
    assert.match(last.stderrDigest.sha256, /^[a-f0-9]{64}$/);
    // Raw bytes never land on disk.
    const onDisk = fs.readFileSync(path.join(tmp, 'w', 'audit.jsonl'), 'utf8');
    assert.doesNotMatch(onDisk, /system: be careful/);
    assert.doesNotMatch(onDisk, /hello world/);
    assert.doesNotMatch(onDisk, /deprecated/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('listAudit filters by runId and type while keeping the no-arg call compatible', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l2-audit-'));
  try {
    const store = new StateStore({ root: tmp, workspaceId: 'w' });
    const log = new AuditLog({ workspaceId: 'w', store });
    log.taskCreated({ taskId: 't1', runId: 'r1', goal: 'g' });
    log.taskCreated({ taskId: 't2', runId: 'r2', goal: 'g' });
    log.nodeFinished({ taskId: 't1', runId: 'r1', nodeId: 'a', status: 'APPLIED', durationMs: 1 });

    const all = store.listAudit();
    assert.equal(all.length, 3);

    const onlyR1 = store.listAudit({ runId: 'r1' });
    assert.equal(onlyR1.length, 2);
    assert.ok(onlyR1.every((e) => e.runId === 'r1'));

    const onlyCreated = store.listAudit({ type: 'TASK_CREATED' });
    assert.equal(onlyCreated.length, 2);
    assert.ok(onlyCreated.every((e) => e.type === 'TASK_CREATED'));

    const combined = store.listAudit({ runId: 'r1', type: 'TASK_CREATED' });
    assert.equal(combined.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AuditLog skips corrupt audit lines without losing healthy ones', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l2-audit-'));
  try {
    const store = new StateStore({ root: tmp, workspaceId: 'w' });
    const log = new AuditLog({ workspaceId: 'w', store });
    log.taskCreated({ taskId: 't1', runId: 'r1', goal: 'ok' });
    fs.appendFileSync(path.join(tmp, 'w', 'audit.jsonl'), '{not json\n', 'utf8');
    log.taskCreated({ taskId: 't2', runId: 'r2', goal: 'ok' });
    const events = store.listAudit();
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.type === 'TASK_CREATED'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('orchestration projection is documented as non-authoritative telemetry', () => {
  // This test asserts only that the wrapper surface exists; deeper policy
  // checks live in the orchestrator (Task 10). The audit table is a
  // rebuildable observability projection; it cannot authorize mutation,
  // produce trusted Evidence, or declare completion.
  const log = new AuditLog({ workspaceId: 'w' });
  assert.equal(typeof log.taskCreated, 'function');
  assert.equal(typeof log.runtimeDecided, 'function');
});