// Environment adapter for Python.
//
// Detect: runs `<python executable> --version` and parses the major.minor
// (e.g. `Python 3.12.4` -> `3.12`). Falls back to `python3` if `python` is
// missing. If neither is available, reports MISSING.
//
// Apply: M2 no-op (see node.mjs for rationale).

import { spawnSync } from 'node:child_process';
import { BaseAdapter, applyResult } from '../core/adapters.mjs';
import { ResourceState } from '../core/state.mjs';

const EXECUTABLE_CANDIDATES = Object.freeze(['python', 'python.exe', 'python3', 'python3.exe']);

function findExecutable() {
  for (const candidate of EXECUTABLE_CANDIDATES) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function parseVersion(stdout, stderr) {
  const text = `${stdout ?? ''}${stderr ?? ''}`;
  const m = text.match(/Python\s+(\d+\.\d+)(?:\.\d+)?/);
  return m ? m[1] : null;
}

export class PythonAdapter extends BaseAdapter {
  constructor(options = {}) {
    super({
      id: 'python',
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
    // Python prints --version to stderr on some platforms; capture both.
    const probe = spawnSync(exe, ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      return new ResourceState({ resource: this.id, version: null, status: 'ERROR', details: { stderr: probe.stderr } });
    }
    const version = parseVersion(probe.stdout, probe.stderr);
    return new ResourceState({
      resource: this.id,
      version,
      status: version == null ? 'UNKNOWN' : 'INSTALLED',
      details: { executable: exe, raw: `${probe.stdout}${probe.stderr}`.trim() },
    });
  }
  async install(version) {
    this._check('install');
    return applyResult({ changed: false, status: 'INSTALLED', message: `M2 no-op install python@${version}` });
  }
  async update(version) {
    this._check('update');
    return applyResult({ changed: false, status: 'INSTALLED', message: `M2 no-op update python@${version}` });
  }
  async verify(desired) {
    this._check('verify');
    const observed = await this.detect();
    const matches = desired == null || observed.version === desired;
    return {
      success: matches,
      status: matches ? 'PASS' : 'WARNING',
      message: matches ? '' : `python observed ${observed.version ?? 'missing'} != desired ${desired}`,
      details: { observed: observed.version, desired },
    };
  }
}