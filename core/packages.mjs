// Package model — unified shape for skill / mcp / workflow / agent packages.
//
// Per spec §11:
//   id, type, version, source, dependencies, permissions, compatible_agents,
//   install, update, uninstall
//
// Level 1 only fully implements 'skill' and 'mcp' (plan Task 6); the
// remaining schemas are reserved in the registry.

export class PackageError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'PackageError';
    this.code = options.code ?? 'PACKAGE_ERROR';
    this.packageId = options.packageId ?? null;
  }
}

const VALID_ID = /^[A-Za-z0-9._-]+$/;
const KNOWN_TYPES = new Set(['skill', 'mcp', 'workflow', 'agent', 'project-template', 'knowledge-pack', 'environment-pack', 'workspace-template']);

export function validatePackageDefinition(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw new PackageError('package definition must be an object', { code: 'PACKAGE_SHAPE_ERROR' });
  }
  if (typeof def.id !== 'string' || !VALID_ID.test(def.id)) {
    throw new PackageError(`package.id "${def.id}" is missing or has illegal characters`, {
      code: 'PACKAGE_FIELD_INVALID',
      packageId: def.id,
    });
  }
  if (!KNOWN_TYPES.has(def.type)) {
    throw new PackageError(`package.type "${def.type}" is not recognized`, {
      code: 'PACKAGE_FIELD_INVALID',
      packageId: def.id,
    });
  }
  // Other types (workflow, agent, project-template, etc.) are reserved for
  // later milestones per spec §11 — accepted but not implemented here.
  return def;
}

export class PackageDefinition {
  constructor({ id, type, version = '0.0.0', source = null, dependencies = [], permissions = {}, compatible_agents = [], install = null, update = null, uninstall = null } = {}) {
    validatePackageDefinition({ id, type, version, source });
    this.id = id;
    this.type = type;
    this.version = version;
    this.source = source;
    this.dependencies = Array.isArray(dependencies) ? [...dependencies] : [];
    this.permissions = permissions && typeof permissions === 'object' ? { ...permissions } : {};
    this.compatible_agents = Array.isArray(compatible_agents) ? [...compatible_agents] : [];
    this.install = install;
    this.update = update;
    this.uninstall = uninstall;
  }
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      version: this.version,
      source: this.source,
      dependencies: this.dependencies,
      permissions: this.permissions,
      compatible_agents: this.compatible_agents,
    };
  }
}

export class PackageRegistry {
  constructor() {
    this._packages = new Map();
  }
  register(pkg) {
    if (!(pkg instanceof PackageDefinition)) pkg = new PackageDefinition(pkg);
    this._packages.set(pkg.id, pkg);
  }
  get(id) { return this._packages.get(id) ?? null; }
  has(id) { return this._packages.has(id); }
  delete(id) { return this._packages.delete(id); }
  list() { return [...this._packages.values()]; }
  applyManifest(declared) {
    if (declared == null) return;
    if (!Array.isArray(declared)) {
      throw new PackageError('manifest.packages must be an array', { code: 'PACKAGE_BAD_MANIFEST' });
    }
    for (const def of declared) {
      validatePackageDefinition(def);
      this.register(def);
    }
  }
}
