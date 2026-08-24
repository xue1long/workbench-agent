// Environment adapter for Node.js.
//
// Detect: runs `<node executable> --version` and parses the major version
// (e.g. `v22.4.1` -> `22`). If the executable is missing or returns a
// non-zero exit code, the resource is reported as MISSING.
//
// Apply: M2 no-op. install() and update() succeed without side effects so
// the runtime can prove the Detect -> Plan -> Apply chain end-to-end
// without ever modifying the host. Real installation belongs to a later
// milestone.

import { spawnSync } from 'node:child_process';
import { BaseAdapter, applyResult } from '../core/adapters.mjs';
import { ResourceState } from '../core/state.mjs';

const EXECUTABLE_CANDIDATES = Object.freeze(['node', 'node.exe']);

function findExecutable() {
  for (const candidate of EXECUTABLE_CANDIDATES) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function parseVersion(stdout) {
  if (typeof stdout !== 'string') return null;
  const m = stdout.match(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? m[1] : null;
}

export class NodeAdapter extends BaseAdapter {
  constructor(options = {}) {
    super({
      id: 'node',
      executable: options.executable ?? null,
      allowedActions: new Set(['detect', 'verify', 'install', 'update']),
    });
    this._executable = options.executable ?? null;
  }
  async detect() {
    this._check('detect');
    if (this._executable === false) {
      return new ResourceState({ resource: this.id, version: null, status: 'MISSING', details: { reason: 'detection disabled' } });
    }
    const exe = this._executable ?? findExecutable();
    if (!exe) {
      return new ResourceState({ resource: this.id, version: null, status: 'MISSING' });
    }
    const probe = spawnSync(exe, ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      return new ResourceState({ resource: this.id, version: null, status: 'ERROR', details: { stderr: probe.stderr } });
    }
    const version = parseVersion(probe.stdout);
    return new ResourceState({
      resource: this.id,
      version,
      status: version == null ? 'UNKNOWN' : 'INSTALLED',
      details: { executable: exe, raw: probe.stdout.trim() },
    });
  }
  async install(version) {
    this._check('install');
    return applyResult({ changed: false, status: 'INSTALLED', message: `M2 no-op install node@${version}` });
  }
  async update(version) {
    this._check('update');
    return applyResult({ changed: false, status: 'INSTALLED', message: `M2 no-op update node@${version}` });
  }
  async verify(desired) {
    this._check('verify');
    const observed = await this.detect();
    const matches = desired == null || observed.version === desired;
    return {
      success: matches,
      status: matches ? 'PASS' : 'WARNING',
      message: matches ? '' :`node observed ${observed.version ?? 'missing'} != desired ${desired}`,
      details: { observed: observed.version, desired },
    };
  }
}
