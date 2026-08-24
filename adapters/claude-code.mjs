// Claude Code adapter — model-level only (M3).
//
// Per spec §15, the Workbench keeps a single Unified Configuration; the
// adapter does not own Claude-specific configuration. This module:
//   * Detects whether the `claude` binary is present and reports its
//     version (from `claude --version`).
//   * Provides a `toAgentConfig(unifiedConfig, secretStore)` method that
//     the Config Translator calls to render the Claude Code config file.
//
// Real config writes (the `apply` path that touches ~/.claude/settings.json)
// belong to the Config Translator (core/config-translator.mjs) — not here.
//
// Like GitAdapter, this module accepts an injectable `runner` so CI never
// has to spawn a real `claude` binary. The default runner uses spawnSync
// with shell:false.

import { spawnSync } from 'node:child_process';
import { BaseAdapter, applyResult } from '../core/adapters.mjs';
import { ResourceState } from '../core/state.mjs';

const EXECUTABLE_CANDIDATES = Object.freeze(['claude', 'claude.exe']);

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

export class ClaudeCodeAdapter extends BaseAdapter {
  constructor(options = {}) {
    super({
      id: 'claude-code',
      executable: options.executable ?? null,
      allowedActions: new Set(['detect', 'verify']),
    });
    this._executable = options.executable ?? null;
    this._didInjectRunner = options.runner !== undefined;
    // Use the injected runner when provided; otherwise the default
    // spawnSync runner. CI / tests always pass `runner` so the real
    // binary is never invoked.
    this._runner = options.runner ?? defaultRunner(this._executable ?? 'claude');
  }
  async detect() {
    this._check('detect');
    if (this._executable === false) {
      return new ResourceState({ resource: this.id, version: null, status: 'DISABLED' });
    }
    // PATH probe only happens when no runner was injected (i.e. real CLI
    // use). When a runner is injected, the test must also pass an
    // `executable` string explicitly — otherwise we cannot safely do PATH
    // resolution through the fake runner.
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
   * Render a Claude Code config file from the unified config + secret
   * references. The translator calls this. The returned object is the
   * shape Claude Code expects; secret references are redacted unless
   * `resolveSecrets` is true (which is reserved for the local machine —
   * never for portable artifacts).
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
    return {
      mcpServers: Object.fromEntries(
        (unified.mcpServers || []).filter((s) => s.enabled !== false).map((s) => [
          s.id,
          s.transport === 'stdio'
            ? { command: s.command, args: s.args || [], env }
            : { type: 'http', url: s.command },
        ])
      ),
    };
  }
}
