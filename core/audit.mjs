// AuditLog — append-only record of every state-changing action.
//
// Spec §25:
//   timestamp, workspace, resource, action, before, after, result, error
//
// Spec §17 + §30: secret values MUST NOT appear in audit records. The
// AuditLog redacts:
//   * Fields named `token`, `secret`, `password`, `key`, `apiKey`,
//     `api_key`, or anything ending in `_token` / `_secret` / `_key`.
//   * String values matching the configured secret-reference shape
//     `{ secret: NAME }`.
//   * Inside objects, recurse with the same redaction policy.
//
// Audit records are written to a StateStore's `audit` table; a default
// file-backed store is constructed when none is provided.
//
// Level 2 adds orchestration wrappers that emit uppercase event types and
// digest raw prompt / context / stdout / stderr fields. The audit table is
// rebuildable observability telemetry — it cannot authorize mutation, emit
// trusted Evidence, or declare final completion (those live in DevFlow
// Runtime's EventStore).

import { createHash } from 'node:crypto';
import { StateStore } from './store.mjs';

export class AuditLogError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AuditLogError';
    this.code = options.code ?? 'AUDIT_ERROR';
  }
}

const DEFAULT_REDACT_FIELDS = new Set([
  'token',
  'secret',
  'password',
  'key',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'cookie',
  'session',
]);

const RAW_DIGEST_FIELDS = new Set(['prompt', 'context', 'stdout', 'stderr']);

const REDACTED = '***REDACTED***';

export function digestText(value) {
  if (typeof value !== 'string') {
    throw new AuditLogError('digestText requires a string', { code: 'AUDIT_BAD_DIGEST_INPUT' });
  }
  const buf = Buffer.from(value, 'utf8');
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

function digestRawField(field, value) {
  const digestName = `${field}Digest`;
  if (value === undefined) return undefined;
  if (value === null) {
    return { [digestName]: { sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'), bytes: 0 } };
  }
  if (typeof value === 'string') {
    return { [digestName]: digestText(value) };
  }
  // Serialize objects as canonical JSON before digesting so nested values are
  // hashed without persisting raw bytes.
  const text = JSON.stringify(value);
  return { [digestName]: digestText(text) };
}

/**
 * Recursively redact fields that look like secrets. Returns a NEW object;
 * the input is not mutated.
 */
export function redact(value, options = {}) {
  const fields = new Set([...DEFAULT_REDACT_FIELDS, ...(options.fields ?? [])]);
  return redactInner(value, fields, new WeakSet());
}

function redactInner(value, fields, seen) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);

  // Typed built-ins: redact by behavior, not by JSON-shaped iteration.
  // Map / Set entries must be walked and each entry individually redacted.
  // Buffer / Date / Error carry bytes / fields that may include secrets
  // (e.g. Error.message); replace them with a safe summary so secret
  // bytes never persist.
  if (value instanceof Map) {
    const out = new Map();
    for (const [k, v] of value.entries()) {
      // Map keys may be strings (then shouldRedactKey applies) or objects.
      // Values are always redacted recursively.
      const redactedKey = typeof k === 'string' && shouldRedactKey(k, fields) ? REDACTED : redactInner(k, fields, seen);
      const redactedValue = v && typeof v === 'object' && typeof v.secret === 'string'
        ? REDACTED
        : redactInner(v, fields, seen);
      out.set(redactedKey, redactedValue);
    }
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    for (const v of value.values()) out.add(redactInner(v, fields, seen));
    return out;
  }
  if (Buffer.isBuffer(value)) {
    return `<Buffer length=${value.length}>`;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    // Strip the raw stack trace — Error.message gets redacted above, but
    // `value.stack` includes the message verbatim and would leak secrets.
    return { name: value.name, message: REDACTED, stack: REDACTED };
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, fields, seen));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (shouldRedactKey(k, fields)) {
      out[k] = REDACTED;
      continue;
    }
    if (v && typeof v === 'object' && typeof v.secret === 'string') {
      // Secret reference shape: { secret: NAME } — replace with REDACTED.
      out[k] = REDACTED;
      continue;
    }
    out[k] = redactInner(v, fields, seen);
  }
  return out;
}

function shouldRedactKey(key, fields) {
  const lower = key.toLowerCase();
  if (fields.has(lower)) return true;
  if (lower.endsWith('_token') || lower.endsWith('_secret') || lower.endsWith('_key') || lower.endsWith('_password')) return true;
  return false;
}

export class AuditLog {
  constructor(options = {}) {
    if (options.store != null && !(options.store instanceof StateStore)) {
      throw new AuditLogError('AuditLog.store must be a StateStore instance', { code: 'AUDIT_BAD_STORE' });
    }
    this._store = options.store ?? new StateStore({ workspaceId: options.workspaceId });
    this._extraFields = options.extraRedactFields ?? [];
  }
  /**
   * Record one audit event. Returns the redacted record that was written.
   * The store is responsible for durability.
   *
   * Raw fields named ``prompt`` / ``context`` / ``stdout`` / ``stderr`` are
   * replaced by a digest (sha256 + byte count) before persistence; the raw
   * bytes never touch the JSONL projection. ``kind`` and existing wrappers
   * continue to work unchanged.
   */
  record(event) {
    if (!event || typeof event !== 'object') {
      throw new AuditLogError('audit event must be an object', { code: 'AUDIT_BAD_EVENT' });
    }
    const sanitized = { ...event };
    for (const field of RAW_DIGEST_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(sanitized, field)) {
        const value = sanitized[field];
        delete sanitized[field];
        const digestEntry = digestRawField(field, value);
        if (digestEntry) Object.assign(sanitized, digestEntry);
      }
    }
    const record = redact({
      ...sanitized,
      timestamp: event.timestamp ?? new Date().toISOString(),
    }, { fields: this._extraFields });
    this._store.recordAudit(record);
    return record;
  }
  /**
   * Convenience wrappers for common event shapes.
   */
  resourceObserved(resource, observed) {
    return this.record({ kind: 'resource.observed', resource, observed });
  }
  executionStarted(plan, mode) {
    return this.record({ kind: 'execution.started', mode, steps: plan.steps.length });
  }
  stepApplied({ resource, action, before, after, status, error }) {
    return this.record({ kind: 'step.applied', resource, action, before, after, status, error: error ? redact(error) : null });
  }
  executionFinished(report) {
    return this.record({ kind: 'execution.finished', summary: report.summary, changed: report.changed });
  }
  verificationRun(report) {
    return this.record({ kind: 'verification.run', report: redact(report) });
  }
  lockfileWritten(path) {
    return this.record({ kind: 'lockfile.written', path });
  }
  snapshotCreated({ id, captured }) {
    return this.record({ kind: 'snapshot.created', id, captured: captured.map((c) => c.source) });
  }
  snapshotRestored({ id, restored }) {
    return this.record({ kind: 'snapshot.restored', id, restored: restored.map((r) => r.to) });
  }
  rollback({ snapshotId, reason }) {
    return this.record({ kind: 'rollback', snapshotId, reason });
  }

  // ---- Level 2 orchestration wrappers ---------------------------------
  // Each wrapper produces a single uppercase ``type`` event. The wrappers
  // intentionally do not authorize mutation, create trusted Evidence, or
  // declare final completion; those decisions live in DevFlow Runtime.

  taskCreated({ taskId, runId, goal }) {
    return this.record({ type: 'TASK_CREATED', taskId, runId, goal });
  }
  taskPlanned({ taskId, runId, nodeIds }) {
    return this.record({ type: 'TASK_PLANNED', taskId, runId, nodeIds: [...nodeIds] });
  }
  agentSelected({ taskId, runId, nodeId, agentId, score, reasons }) {
    return this.record({ type: 'AGENT_SELECTED', taskId, runId, nodeId, agentId, score, reasons: [...reasons] });
  }
  nodeStarted({ taskId, runId, nodeId, context }) {
    return this.record({ type: 'AGENT_STARTED', taskId, runId, nodeId, context });
  }
  toolCalled({ taskId, runId, nodeId, tool, argumentsDigest }) {
    return this.record({ type: 'TOOL_CALLED', taskId, runId, nodeId, tool, argumentsDigest });
  }
  nodeFinished({ taskId, runId, nodeId, status, durationMs }) {
    return this.record({ type: 'NODE_EXECUTION_SUCCEEDED', taskId, runId, nodeId, status, durationMs });
  }
  nodeRetried({ taskId, runId, nodeId, attempt, reason }) {
    return this.record({ type: 'TASK_RETRIED', taskId, runId, nodeId, attempt, reason });
  }
  nodeFailed({ taskId, runId, nodeId, reason }) {
    return this.record({ type: 'TASK_FAILED', taskId, runId, nodeId, reason });
  }
  planRevised({ taskId, runId, reason, graphRevision }) {
    return this.record({ type: 'PLAN_REVISED', taskId, runId, reason, graphRevision });
  }
  changeSetCreated({ taskId, runId, patchSha256, changedFiles }) {
    return this.record({ type: 'CHANGESET_CREATED', taskId, runId, patchSha256, changedFiles: [...changedFiles] });
  }
  actionProposed({ taskId, runId, actionId, files }) {
    return this.record({ type: 'ACTION_PROPOSED', taskId, runId, actionId, files: [...files] });
  }
  runtimeDecided({ taskId, runId, sessionId, decision, integrity }) {
    return this.record({ type: 'RUNTIME_DECIDED', taskId, runId, sessionId, decision, integrity });
  }
  taskExecutionSucceeded({ taskId, runId }) {
    return this.record({ type: 'TASK_EXECUTION_SUCCEEDED', taskId, runId });
  }
  taskFailed({ taskId, runId, reason }) {
    return this.record({ type: 'TASK_FAILED', taskId, runId, reason });
  }
  taskHalted({ taskId, runId, reason }) {
    return this.record({ type: 'TASK_HALTED', taskId, runId, reason });
  }
  taskQuarantined({ taskId, runId, reason }) {
    return this.record({ type: 'TASK_QUARANTINED', taskId, runId, reason });
  }
}
