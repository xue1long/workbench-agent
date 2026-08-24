// Workspace Core state model — Desired vs Observed vs Applied.
//
// Per the runtime spec (Agent Workbench Level 1, §9 "State Model"):
//   - Desired State lives in workspace.yaml/json (portable).
//   - Current State lives in the SQLite state store (machine-scoped).
//   - Observed State is what adapters just measured on this host.
//   - Last Applied State is the snapshot recorded after a successful Apply.
//
// M2 keeps everything in-memory; SQLite persistence lands in Task 4.
// All exports are pure constructors and pure value types.

export const KNOWN_ENVIRONMENT_RESOURCES = ['node', 'python', 'uv'];

/**
 * ResourceState captures everything we know about a single resource on the
 * host. `version` is null when the tool is missing.
 */
export class ResourceState {
  constructor({ resource, version = null, status, details = {} } = {}) {
    if (typeof resource !== 'string' || resource.length === 0) {
      throw new TypeError('ResourceState requires a non-empty resource name');
    }
    this.resource = resource;
    this.version = version == null ? null : String(version);
    // Default status: a measured version means INSTALLED, no version means MISSING.
    // Callers can override (e.g. ERROR, OUTDATED).
    this.status = status ?? (this.version == null ? 'MISSING' : 'INSTALLED');
    this.details = details;
  }
}

/**
 * ObservedState is the union of ResourceStates for every resource we know
 * how to detect. It is the input to `planFromManifest` and to `applyPlan`.
 */
export class ObservedState {
  constructor(resources = []) {
    this.resources = new Map();
    if (resources instanceof Map) {
      for (const [name, state] of resources) this._set(name, state);
      return;
    }
    if (Array.isArray(resources)) {
      for (const item of resources) this._set(item.resource, item);
      return;
    }
    if (resources && typeof resources === 'object') {
      // Plain object: { node: '22', python: '3.12', uv: null }
      for (const [name, version] of Object.entries(resources)) {
        this._set(name, new ResourceState({ resource: name, version }));
      }
    }
  }
  _set(name, state) {
    if (!(state instanceof ResourceState)) {
      state = new ResourceState({
        resource: name,
        version: state?.version ?? null,
        status: state?.status ?? (state?.version == null ? 'MISSING' : 'INSTALLED'),
        details: state?.details ?? {},
      });
    } else if (state.resource !== name) {
      state = new ResourceState({
        resource: name,
        version: state.version,
        status: state.status,
        details: state.details,
      });
    }
    this.resources.set(name, state);
  }
  has(name) { return this.resources.has(name); }
  get(name) { return this.resources.get(name) ?? null; }
  set(state) {
    if (!(state instanceof ResourceState)) {
      throw new TypeError('ObservedState.set expects a ResourceState');
    }
    this.resources.set(state.resource, state);
  }
  entries() { return [...this.resources.entries()]; }
  toJSON() {
    return Object.fromEntries(
      [...this.resources.entries()].map(([name, state]) => [
        name,
        { version: state.version, status: state.status, details: state.details },
      ])
    );
  }
}

/**
 * AppliedState records what an Apply step actually accomplished. This is
 * what later gets written to the lockfile (Task 7) and audited (Task 4).
 */
export class AppliedStep {
  constructor({ resource, action, version, previous = null, status = 'APPLIED', message = '', details = {}, error = null, at = null } = {}) {
    this.resource = resource;
    this.action = action; // INSTALL | UPDATE | SKIP
    this.version = version;
    this.previous = previous;
    this.status = status; // APPLIED | FAILED | SKIPPED | ROLLED_BACK
    this.message = message;
    this.details = details;
    this.error = error; // { code } or null
    this.at = at ?? new Date().toISOString();
  }
}

export class AppliedState {
  constructor(workspaceId, steps = []) {
    this.workspaceId = workspaceId;
    this.steps = steps.map((s) => (s instanceof AppliedStep ? s : new AppliedStep(s)));
  }
  add(step) { this.steps.push(step instanceof AppliedStep ? step : new AppliedStep(step)); }
  get(resource) { return this.steps.find((s) => s.resource === resource) ?? null; }
  toJSON() {
    return {
      workspaceId: this.workspaceId,
      steps: this.steps.map((s) => ({ ...s })),
    };
  }
}

export function diffResource(desiredVersion, currentVersion) {
  if (currentVersion == null) return { action: 'INSTALL', version: desiredVersion, previous: null };
  if (currentVersion === desiredVersion) return { action: 'SKIP', version: currentVersion, previous: null };
  return { action: 'UPDATE', version: desiredVersion, previous: currentVersion };
}
