// Config Translator — renders unified config into per-agent config files.
//
// Per spec §15:
//   Unified Config -> Config Translator -> Claude Config
//                  -> Config Translator -> Codex Config
//
// The translator takes:
//   * `unified` — the merged AgentDefinition + McpDefinition + environment
//     references assembled from the manifest
//   * `secretStore` — the in-memory or OS-backed secret store (used when
//     `resolveSecrets: true` to inline secret values for local writes only;
//     portable artifacts always keep references)
//   * `agents` — the agent adapter registry
//
// It produces per-agent config objects (not files). File IO happens in a
// thin shell command that the Config Translator emits, not in here.

import fs from 'node:fs';
import path from 'node:path';
import { InMemorySecretStore } from './secrets.mjs';

export class ConfigTranslatorError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ConfigTranslatorError';
    this.code = options.code ?? 'CONFIG_TRANSLATOR_ERROR';
    this.agentId = options.agentId ?? null;
  }
}

/**
 * Resolve any `{ secret: NAME }` references in `unified.environment` to
 * their actual values, when the secret exists in the store. Cycle-guarded
 * and only walks the unified config object — never reaches into adapter
 * internals.
 *
 * When `secretStore` is provided, any reference whose name is NOT in the
 * store is a configuration error and raises ConfigTranslatorError —
 * silently emitting `{ secret: NAME }` references into agent config files
 * would leak which secret slots the operator uses (spec §17).
 */
export function resolveSecretReferences(unified, secretStore) {
  if (!unified || typeof unified !== 'object') return unified;
  const env = unified.environment;
  if (env == null || typeof env !== 'object') return unified;
  const resolved = {};
  for (const [key, value] of Object.entries(env)) {
    if (value && typeof value === 'object' && typeof value.secret === 'string') {
      if (secretStore) {
        if (!secretStore.exists(value.secret)) {
          throw new ConfigTranslatorError(
            `environment.${key} references secret "${value.secret}" which is not in the secret store`,
            { code: 'MISSING_SECRET' }
          );
        }
        const actual = secretStore.get(value.secret);
        resolved[key] = actual == null ? value : actual;
      } else {
        resolved[key] = value;
      }
    } else {
      resolved[key] = value;
    }
  }
  return { ...unified, environment: resolved };
}

/**
 * Translate the unified config into a per-agent config object.
 * Secret references are redacted by default; pass `resolveSecrets: true`
 * AND `secretStore` for local-machine writes that should inline values.
 */
export function translateConfig(unified, agentAdapter, options = {}) {
  if (!unified || typeof unified !== 'object') {
    throw new ConfigTranslatorError('unified config must be an object', { code: 'BAD_UNIFIED_CONFIG' });
  }
  if (!agentAdapter || typeof agentAdapter.toAgentConfig !== 'function') {
    throw new ConfigTranslatorError('agent adapter must implement toAgentConfig()', { code: 'BAD_ADAPTER' });
  }
  const sourceUnified = options.resolveSecrets === true && options.secretStore
    ? resolveSecretReferences(unified, options.secretStore)
    : unified;
  return agentAdapter.toAgentConfig(sourceUnified, options);
}

/**
 * Persist a translated config to disk. The translator never writes files
 * itself; this is a thin wrapper that the apply engine calls.
 *
 * Refuses to overwrite paths outside `workspaceRoot`. Refuses to write
 * files that don't have `.json` / `.toml` extensions.
 */
export function writeAgentConfigFile(translatedConfig, agentDef, options = {}) {
  const root = options.workspaceRoot ? path.resolve(options.workspaceRoot) : process.cwd();
  const configPath = options.configPath ?? agentDef.configPaths?.[0];
  if (!configPath) {
    throw new ConfigTranslatorError(`agent "${agentDef.id}" has no configPaths`, {
      code: 'NO_CONFIG_PATH',
      agentId: agentDef.id,
    });
  }
  // Resolve and reject escapes.
  const absolute = path.isAbsolute(configPath) ? path.resolve(configPath) : path.resolve(root, configPath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ConfigTranslatorError(`agent "${agentDef.id}" config path escapes workspace root`, {
      code: 'CONFIG_PATH_ESCAPE',
      agentId: agentDef.id,
    });
  }
  const ext = path.extname(absolute).toLowerCase();
  if (!['.json', '.toml'].includes(ext)) {
    throw new ConfigTranslatorError(`agent "${agentDef.id}" config path extension "${ext}" is not allowed`, {
      code: 'CONFIG_EXTENSION_INVALID',
      agentId: agentDef.id,
    });
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  // Snapshot pre-write for rollback (Task 7 will own this; the translator
  // just preserves a copy when asked).
  if (options.snapshotDir) {
    try {
      if (fs.existsSync(absolute)) {
        fs.mkdirSync(options.snapshotDir, { recursive: true });
        const backup = path.join(options.snapshotDir, path.basename(absolute) + '.bak');
        fs.copyFileSync(absolute, backup);
      }
    } catch (_) {
      // Snapshot failure is best-effort; never blocks a write.
    }
  }
  const body = ext === '.json' ? JSON.stringify(translatedConfig, null, 2) : tomlStringify(translatedConfig);
  fs.writeFileSync(absolute, body, 'utf8');
  return { written: absolute };
}

function tomlStringify(obj) {
  // Minimal TOML emitter. Two section shapes are recognized:
  //   { section: { key: value, ... } }                 -> [section]\nkey = ...
  //   { section: { subId: { key: value, ... }, ... } }  -> [section.subId]\nkey = ...
  const lines = [];
  for (const [section, content] of Object.entries(obj)) {
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      const subEntries = Object.entries(content);
      // Heuristic: if every sub-entry's value is itself an object, emit
      // each sub-entry as its own [section.subId] block. Otherwise emit
      // a single [section] block with flat key/value pairs.
      const allObjects = subEntries.every(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
      if (allObjects && subEntries.length > 0) {
        for (const [subId, fields] of subEntries) {
          lines.push(`[${section}.${subId}]`);
          for (const [k, v] of Object.entries(fields)) {
            lines.push(`${k} = ${tomlValue(v)}`);
          }
          lines.push('');
        }
      } else {
        lines.push(`[${section}]`);
        for (const [k, v] of subEntries) {
          lines.push(`${k} = ${tomlValue(v)}`);
        }
        lines.push('');
      }
    } else {
      lines.push(`${section} = ${tomlValue(content)}`);
    }
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function tomlValue(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  if (v && typeof v === 'object') return JSON.stringify(v);
  return '""';
}

/**
 * Convenience: build the unified config object from manifest sections.
 */
export function buildUnifiedConfig({ environment = {}, agents = [], mcp = [], secrets = [] } = {}) {
  return {
    environment: environment || {},
    agents: Array.isArray(agents) ? agents : [],
    mcpServers: Array.isArray(mcp) ? mcp : [],
    secrets: Array.isArray(secrets) ? secrets : [],
  };
}

// Default secret store used when none is provided. Tests pass an
// InMemorySecretStore explicitly; production wires the OS-backed one.
export function defaultSecretStore() {
  return new InMemorySecretStore();
}