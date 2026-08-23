// Workspace Core adapter contract.
//
// Per the runtime spec (Agent Workbench Level 1, §12):
//   detect()           -> ResourceState
//   getVersion()       -> string | null
//   getStatus()        -> 'INSTALLED' | 'MISSING' | 'OUTDATED' | 'UNKNOWN'
//   install(version)   -> AdapterResult
//   update(version)    -> AdapterResult
//   configure(opts)    -> AdapterResult
//   verify(desired)    -> VerificationResult
//   uninstall()        -> AdapterResult (M2 must NOT delete managed state; refused by default)
//
// All methods that mutate MUST return a uniform AdapterResult shape:
//   { success: boolean, changed: boolean, status: string, message: string, details: object }
//
// M2 ships EnvironmentAdapters (node/python/uv) as noop apply + real detect.
// Any tool whose lifecycle we cannot safely automate (force push, hard reset,
// delete) is refused by default. Tests use FakeAdapter to avoid touching PATH.

import { ResourceState, diffResource } from './state.mjs';

export const REFUSE_ACTIONS = new Set(['force-push', 'branch-delete', 'reset-hard', 'uninstall-managed']);

export class AdapterError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = options.code ?? 'ADAPTER_ERROR';
    this.resource = options.resource ?? null;
    this.action = options.action ?? null;
    this.cause = options.cause ?? null;
  }
}

export function adapterResult({ success, changed, status, message = '', details = {} }) {
  return { success: !!success, changed: !!changed, status, message, details };
}

export function okResult(status, message = '', details = {}) {
  return adapterResult({ success: true, changed: false, status, message, details });
}

export function applyResult({ changed, status, message = '', details = {} }) {
  return adapterResult({ success: true, changed: !!changed, status, message, details });
}

/**
 * BaseAdapter validates arguments and provides a safe no-op default. Concrete
 * adapters override only what they can do safely.
 */
export class BaseAdapter {
  constructor({ id, executable = null, allowedActions = new Set(['detect', 'verify']) } = {}) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('Adapter requires a non-empty id');
    }
    this.id = id;
    this.executable = executable;
    this.allowedActions = new Set(allowedActions);
  }
  _check(action) {
    if (REFUSE_ACTIONS.has(action)) {
      throw new AdapterError(`action "${action}" is refused by adapter "${this.id}" (M2 safety policy)`, {
        code: 'ADAPTER_ACTION_REFUSED',
        resource: this.id,
        action,
      });
    }
    if (!this.allowedActions.has(action)) {
      throw new AdapterError(`action "${action}" is not allowed for adapter "${this.id}"`, {
        code: 'ADAPTER_ACTION_NOT_ALLOWED',
        resource: this.id,
        action,
      });
    }
  }
  async detect() {
    this._check('detect');
    return new ResourceState({ resource: this.id, version: null, status: 'UNKNOWN' });
  }
  async getVersion() { return (await this.detect()).version; }
  async getStatus() { return (await this.detect()).status; }
  async install(_version) {
    this._check('install');
    return applyResult({ changed: true, status: 'INSTALLED', message: `${this.id} install is a no-op in M2` });
  }
  async update(_version) {
    this._check('update');
    return applyResult({ changed: true, status: 'INSTALLED', message: `${this.id} update is a no-op in M2` });
  }
  async configure(_options) {
    this._check('configure');
    return okResult('CONFIGURED', `${this.id} configure is a no-op in M2`);
  }
  async verify(_desired) {
    this._check('verify');
    return { success: true, status: 'UNKNOWN', message: `${this.id} verify is a no-op in M2`, details: {} };
  }
  async uninstall() {
    // M2 default: refused by safety policy. Concrete adapters must override
    // this method to opt in, and should do so under an explicit, audited
    // authorization (spec §18). Throwing here keeps the default safe even
    // when a caller lists 'uninstall' in allowedActions.
    throw new AdapterError(
      `action "uninstall" is refused by adapter "${this.id}" (override uninstall() to opt in)`,
      { code: 'ADAPTER_ACTION_REFUSED', resource: this.id, action: 'uninstall' }
    );
  }
}

/**
 * FakeAdapter lets tests script a sequence of adapter responses without
 * touching the host. It also records every call for assertions.
 */
export class FakeAdapter extends BaseAdapter {
  constructor(options = {}) {
    super({ id: options.id, executable: null, allowedActions: options.allowedActions ?? new Set(['detect', 'install', 'update', 'configure', 'verify', 'uninstall']) });
    this.scripted = options.scripted ?? {};
    this.calls = [];
  }
  _scriptFor(method, args) {
    const handler = this.scripted[method];
    if (typeof handler === 'function') return handler(...args);
    return handler;
  }
  async detect() {
    this.calls.push(['detect']);
    this._check('detect');
    const scripted = this._scriptFor('detect', []);
    if (scripted instanceof ResourceState) return scripted;
    if (scripted && typeof scripted === 'object') {
      return new ResourceState({ resource: this.id, ...scripted });
    }
    return new ResourceState({ resource: this.id, version: scripted ?? null, status: scripted == null ? 'MISSING' : 'INSTALLED' });
  }
  async install(version) {
    this.calls.push(['install', version]);
    this._check('install');
    const scripted = this._scriptFor('install', [version]);
    return scripted ?? applyResult({ changed: true, status: 'INSTALLED' });
  }
  async update(version) {
    this.calls.push(['update', version]);
    this._check('update');
    const scripted = this._scriptFor('update', [version]);
    return scripted ?? applyResult({ changed: true, status: 'INSTALLED' });
  }
  async configure(options) {
    this.calls.push(['configure', options]);
    this._check('configure');
    const scripted = this._scriptFor('configure', [options]);
    return scripted ?? okResult('CONFIGURED');
  }
  async verify(desired) {
    this.calls.push(['verify', desired]);
    this._check('verify');
    const scripted = this._scriptFor('verify', [desired]);
    if (scripted && typeof scripted === 'object' && 'success' in scripted) return scripted;
    return { success: true, status: 'UNKNOWN', message: '', details: {} };
  }
  async uninstall() {
    this.calls.push(['uninstall']);
    this._check('uninstall');
    const scripted = this._scriptFor('uninstall', []);
    return scripted ?? applyResult({ changed: true, status: 'MISSING' });
  }
}

/**
 * Plan a single resource given its desired version and an adapter that can
 * measure the host. Pure: returns { action, version, previous } only.
 */
export async function planOne(adapter, desiredVersion) {
  const observed = await adapter.detect();
  return { resource: adapter.id, ...diffResource(desiredVersion, observed.version) };
}