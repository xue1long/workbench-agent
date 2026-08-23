// SecretStore — interface + minimal in-memory implementation.
//
// Spec §17 requires:
//   - Manifest stores only references, e.g. environment: { TOKEN: { secret: 'TOKEN' } }
//   - Real secrets live in OS credential store (macOS Keychain / Windows
//     Credential Manager / Linux Secret Service)
//   - get/set/delete/exists interface
//   - Secrets never enter logs, audit, or generated config
//
// This module ships an in-memory implementation (InMemorySecretStore) for
// tests and the default for development. The OS-backed implementation
// belongs to a later milestone once the reference model and redaction tests
// are in place — exactly what spec §17 "real secret backend" requires.

export class SecretError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.code = options.code ?? 'SECRET_ERROR';
    // Preserve the error class for stack traces; `options.name` would
    // overwrite the constructor-set `Error.name` (the previous code did
    // exactly this and ended up with `name === null` when no override).
    this.name = options.name ?? 'SecretError';
  }
}

const VALID_NAME = /^[A-Z][A-Z0-9_]*$/;

function assertName(name) {
  if (typeof name !== 'string' || !VALID_NAME.test(name)) {
    throw new SecretError(`secret name "${name}" must match ${VALID_NAME}`, {
      code: 'SECRET_NAME_INVALID',
      name,
    });
  }
}

/**
 * Normalize a manifest-side reference. Either the raw `{ secret: NAME }`
 * shape, or a bare string `NAME`, is accepted and reduced to a plain
 * `{ secret: NAME }` reference object.
 */
export function normalizeSecretReference(ref) {
  if (typeof ref === 'string') return { secret: ref };
  if (ref && typeof ref === 'object' && typeof ref.secret === 'string') return { secret: ref.secret };
  throw new SecretError(`secret reference must be a string or { secret: NAME }`, { code: 'SECRET_REFERENCE_INVALID' });
}

export class InMemorySecretStore {
  constructor() {
    this._values = new Map();
  }
  get(name) {
    assertName(name);
    return this._values.has(name) ? this._values.get(name) : null;
  }
  set(name, value) {
    assertName(name);
    if (typeof value !== 'string') {
      throw new SecretError('secret value must be a string', { code: 'SECRET_VALUE_INVALID', name });
    }
    this._values.set(name, value);
  }
  delete(name) {
    assertName(name);
    return this._values.delete(name);
  }
  exists(name) {
    assertName(name);
    return this._values.has(name);
  }
  entries() {
    // Returns an iterator over names only — values are NEVER exposed via
    // this API. Tests use it for diagnostics.
    return [...this._values.keys()].values();
  }
  /**
   * Redact a config object in-place. Any key whose value is a
   * `{ secret: NAME }` reference is replaced with `'***REDACTED***'` so
   * the value can't leak into generated artifacts, audit records, or
   * CLI output.
   */
  redactConfig(config, store = this, _seen = new Set()) {
    if (config == null || typeof config !== 'object') return config;
    // Cycle guard: redaction is read-only but a self-referential config
    // would recurse forever. Detect cycles and replace them with the
    // sentinel rather than crashing.
    if (_seen.has(config)) return '***CYCLE***';
    _seen.add(config);
    const result = Array.isArray(config) ? [] : {};
    for (const [key, value] of Object.entries(config)) {
      if (value && typeof value === 'object' && typeof value.secret === 'string' && store.exists(value.secret)) {
        result[key] = '***REDACTED***';
      } else if (value && typeof value === 'object') {
        result[key] = this.redactConfig(value, store, _seen);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}