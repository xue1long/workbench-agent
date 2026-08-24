// Pure manifest validation + planning helpers. No CLI, no IO — just
// functions that take parsed manifest objects and return structured
// results. Re-exported from src/workbench.mjs for back-compat with M1/M2
// tests.

import { validateAgentDefinition } from './agents.mjs';
import { validateMcpDefinition } from './mcp.mjs';
import { validatePackageDefinition } from './packages.mjs';
import { validateProject } from './projects.mjs';

export class ManifestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ManifestError';
    this.code = options.code ?? 'MANIFEST_INVALID';
    this.field = options.field ?? null;
    this.cause = options.cause ?? null;
  }
}

const SUPPORTED_MANIFEST_VERSION = '1';
const VALID_ID = /^[A-Za-z0-9._-]+$/;
const VALID_VERSION = /^[A-Za-z0-9._+\-:]+$/;
const KNOWN_ENVIRONMENT_RESOURCES = ['node', 'python', 'uv'];

export function validateManifest(manifest) {
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ManifestError('manifest root must be an object', {
      code: 'MANIFEST_SHAPE_ERROR',
      field: '<root>',
    });
  }
  if (manifest.version !== SUPPORTED_MANIFEST_VERSION) {
    throw new ManifestError(
      `manifest.version must be the string "${SUPPORTED_MANIFEST_VERSION}" (got ${JSON.stringify(manifest.version)})`,
      { code: 'MANIFEST_VERSION_UNSUPPORTED', field: 'version' }
    );
  }
  const workspace = manifest.workspace;
  if (workspace == null || typeof workspace !== 'object' || Array.isArray(workspace)) {
    throw new ManifestError('manifest.workspace is required and must be an object', {
      code: 'MANIFEST_FIELD_REQUIRED',
      field: 'workspace',
    });
  }
  if (typeof workspace.id !== 'string' || workspace.id.length === 0) {
    throw new ManifestError('manifest.workspace.id is required and must be a non-empty string', {
      code: 'MANIFEST_FIELD_REQUIRED',
      field: 'workspace.id',
    });
  }
  if (!VALID_ID.test(workspace.id)) {
    throw new ManifestError(
      `manifest.workspace.id "${workspace.id}" contains illegal characters; allowed: [A-Za-z0-9._-]`,
      { code: 'MANIFEST_FIELD_INVALID', field: 'workspace.id' }
    );
  }
  const environment = manifest.environment;
  if (environment == null || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new ManifestError('manifest.environment is required and must be an object', {
      code: 'MANIFEST_FIELD_REQUIRED',
      field: 'environment',
    });
  }
  const resources = Object.keys(environment);
  if (resources.length === 0) {
    throw new ManifestError('manifest.environment must declare at least one resource', {
      code: 'MANIFEST_FIELD_REQUIRED',
      field: 'environment',
    });
  }
  const unknown = resources.filter((r) => !KNOWN_ENVIRONMENT_RESOURCES.includes(r));
  if (unknown.length > 0) {
    throw new ManifestError(
      `manifest.environment declares unknown resource(s): ${unknown.join(', ')}; allowed: ${KNOWN_ENVIRONMENT_RESOURCES.join(', ')}`,
      { code: 'MANIFEST_UNKNOWN_RESOURCE', field: 'environment' }
    );
  }
  for (const resource of resources) {
    const entry = environment[resource];
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ManifestError(
        `manifest.environment.${resource} must be an object with a version field`,
        { code: 'MANIFEST_FIELD_REQUIRED', field: `environment.${resource}` }
      );
    }
    if (typeof entry.version !== 'string' || entry.version.length === 0) {
      throw new ManifestError(
        `manifest.environment.${resource}.version is required and must be a non-empty string`,
        { code: 'MANIFEST_FIELD_REQUIRED', field: `environment.${resource}.version` }
      );
    }
    if (!VALID_VERSION.test(entry.version)) {
      throw new ManifestError(
        `manifest.environment.${resource}.version "${entry.version}" contains illegal characters; allowed: [A-Za-z0-9._+\\-:]`,
        { code: 'MANIFEST_FIELD_INVALID', field: `environment.${resource}.version` }
      );
    }
  }

  // M3 sections — validate each entry through its module's validator so
  // typos and structural errors surface here, not deep in apply.
  validateSectionArray(manifest.agents, validateAgentDefinition, 'agents');
  validateSectionArray(manifest.mcp, validateMcpDefinition, 'mcp');
  validateSectionArray(manifest.packages, validatePackageDefinition, 'packages');
  validateSectionArray(manifest.projects, validateProject, 'projects');

  return { workspaceId: workspace.id, resources };
}

function validateSectionArray(section, validator, fieldName) {
  if (section === undefined || section === null) return;
  if (!Array.isArray(section)) {
    throw new ManifestError(
      `manifest.${fieldName} must be an array; got ${typeof section}`,
      { code: 'MANIFEST_FIELD_INVALID', field: fieldName }
    );
  }
  for (let i = 0; i < section.length; i += 1) {
    try {
      validator(section[i]);
    } catch (err) {
      throw new ManifestError(
        `manifest.${fieldName}[${i}] ${err.message}`,
        { code: 'MANIFEST_FIELD_INVALID', field: `${fieldName}[${i}]`, cause: err }
      );
    }
  }
}

export { SUPPORTED_MANIFEST_VERSION, VALID_ID, VALID_VERSION, KNOWN_ENVIRONMENT_RESOURCES };
