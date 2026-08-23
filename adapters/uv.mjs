// Environment adapter for uv (https://docs.astral.sh/uv/).
//
// Detect: runs `<uv executable> --version` and parses the version output.
// uv prints e.g. `uv 0.4.18 (d2cdcc855 2024-12-13)`; we keep the full
// `0.4.18` so a manifest can pin a patch level.
//
// Apply: M2 no-op (see node.mjs for rationale).

import { spawnSync } from 'node:child_process';
import { BaseAdapter, applyResult } from '../core/adapters.mjs';
import { ResourceState } from '../core/state.mjs';

const EXECUTABLE_CANDIDATES = Object.freeze(['uv', 'uv.exe']);

function findExecutable() {
  for (const candidate of EXECUTABLE_CANDIDATES) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function parseVersion(stdout) {
  if (typeof stdout !== 'string') return null;
  const m = stdout.match(/uv\s+(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export class UvAdapter extends BaseAdapter {
  constructor(options = {}) {
    super({
      id: 'uv',
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
    return applyResult({ changed: false, status: 'INSTALLED', message: `M2 no-op install uv@${version}` });
  }
  async update(version) {
    this._check('update');
    return applyResult({ changed: false, status: 'INSTALLED', message: `M2 no-op update uv@${version}` });
  }
  async verify(desired) {
    this._check('verify');
    const observed = await this.detect();
    const matches = desired == null || observed.version === desired || desired === 'latest';
    return {
      success: matches,
      status: matches ? 'PASS' : 'WARNING',
      message: matches ? '' : `uv observed ${observed.version ?? 'missing'} != desired ${desired}`,
      details: { observed: observed.version, desired },
    };
  }
}