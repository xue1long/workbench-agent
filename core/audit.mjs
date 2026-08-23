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

const REDACTED = '***REDACTED***';

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
   */
  record(event) {
    if (!event || typeof event !== 'object') {
      throw new AuditLogError('audit event must be an object', { code: 'AUDIT_BAD_EVENT' });
    }
    const record = redact({
      ...event,
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
}
