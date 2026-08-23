// Codex adapter — model-level only (M3).
//
// Mirrors ClaudeCodeAdapter but with Codex-specific config shape.
// Codex uses a TOML-ish config; for M3 we emit a JSON shape that the
// Config Translator renders into the right format when writing the file.
//
// Like GitAdapter and ClaudeCodeAdapter, this module accepts an
// injectable `runner` so CI never has to spawn a real `codex` binary.

import { spawnSync } from 'node:child_process';
import { BaseAdapter } from '../core/adapters.mjs';
import { ResourceState } from '../core/state.mjs';

const EXECUTABLE_CANDIDATES = Object.freeze(['codex', 'codex.exe']);

function findExecutable() {
  for (const candidate of EXECUTABLE_CANDIDATES) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function defaultRunner(executable) {
  return (args, opts = {}) => {
    const proc = spawnSync(executable, args, { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!opts.allowFail && proc.error) throw proc.error;
    return proc;
  };
}

function parseVersion(stdout) {
  if (typeof stdout !== 'string') return null;
  const m = stdout.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export class CodexAdapter extends BaseAdapter {
  constructor(options = {}) {
    super({
      id: 'codex',
      executable: options.executable ?? null,
      allowedActions: new Set(['detect', 'verify']),
    });
    this._executable = options.executable ?? null;
    this._didInjectRunner = options.runner !== undefined;
    this._runner = options.runner ?? defaultRunner(this._executable ?? 'codex');
  }
  async detect() {
    this._check('detect');
    if (this._executable === false) {
      return new ResourceState({ resource: this.id, version: null, status: 'DISABLED' });
    }
    let exe = this._executable;
    if (!exe) {
      if (this._didInjectRunner) {
        return new ResourceState({ resource: this.id, version: null, status: 'MISSING', details: { reason: 'no executable configured (runner injected)' } });
      }
      exe = findExecutable();
      if (!exe) {
        return new ResourceState({ resource: this.id, version: null, status: 'MISSING' });
      }
    }
    const probe = this._runner(['--version'], { allowFail: true });
    if (probe.status !== 0) {
      return new ResourceState({ resource: this.id, version: null, status: 'ERROR', details: { stderr: probe.stderr } });
    }
    const version = parseVersion(probe.stdout);
    return new ResourceState({
      resource: this.id,
      version,
      status: version == null ? 'UNKNOWN' : 'INSTALLED',
      details: { executable: exe, raw: (probe.stdout || '').trim() },
    });
  }
  async verify(_desired) {
    this._check('verify');
    return { success: true, status: 'UNKNOWN', message: '', details: {} };
  }
  /**
   * Render a Codex config. Codex currently uses a flat key/value
   * structure; MCP entries go under `[mcp_servers.<id>]` sections.
   */
  toAgentConfig(unified, options = {}) {
    const resolveSecrets = options.resolveSecrets === true;
    const env = {};
    for (const [k, v] of Object.entries(unified.environment || {})) {
      if (v && typeof v === 'object' && typeof v.secret === 'string') {
        env[k] = resolveSecrets ? { secret: v.secret } : '***REDACTED***';
      } else {
        env[k] = v;
      }
    }
    const mcpServers = {};
    for (const server of (unified.mcpServers || []).filter((s) => s.enabled !== false)) {
      if (server.transport === 'stdio') {
        mcpServers[server.id] = {
          command: server.command,
          args: server.args || [],
          env,
        };
      } else {
        mcpServers[server.id] = { type: 'http', url: server.command };
      }
    }
    return { mcp_servers: mcpServers };
  }
}