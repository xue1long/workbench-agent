// GitAdapter — wraps git CLI for project clone/fetch/status/verify.
//
// Safety policy (spec §18 + §31):
//   * Refuses force-push, branch-delete, and `reset --hard` by default.
//   * Real mutations only happen behind `applyPlan(apply: true)`; nothing
//     in this module executes destructive commands on import or detect.
//   * Commands are built from validated arg arrays; user-controlled strings
//     flow only as argv entries and never as part of a shell string.
//
// Tests inject a fake command runner so the real `git` binary is never
// invoked from CI; production code calls git with the same arg-array shape.

import { spawnSync } from 'node:child_process';
import { BaseAdapter, applyResult, okResult, AdapterError, registerAdapter } from '../core/adapters.mjs';

const REFUSE = new Set(['force-push', 'branch-delete', 'reset-hard']);

function isRefuse(action) {
  return REFUSE.has(action);
}

export class GitAdapter extends BaseAdapter {
  constructor(options = {}) {
    super({
      id: 'git',
      executable: options.executable ?? 'git',
      allowedActions: new Set(['detect', 'install', 'update', 'verify']),
    });
    this._executable = options.executable ?? 'git';
    this._runner = options.runner ?? defaultRunner(this._executable);
  }
  async detect() {
    this._check('detect');
    const probe = this._runner(['--version'], { allowFail: true });
    if (probe.status !== 0) {
      return { resource: this.id, version: null, status: 'MISSING', details: { stderr: probe.stderr } };
    }
    const m = (probe.stdout || '').match(/git version (\S+)/);
    const version = m ? m[1] : null;
    return {
      resource: this.id,
      version,
      status: version == null ? 'UNKNOWN' : 'INSTALLED',
      details: { executable: this._executable, raw: (probe.stdout || '').trim() },
    };
  }
  async install(_version) {
    this._check('install');
    return applyResult({ changed: false, status: 'INSTALLED', message: 'git binary already installed; nothing to do' });
  }
  async update(_version) {
    this._check('update');
    return applyResult({ changed: false, status: 'INSTALLED', message: 'git binary already installed; nothing to do' });
  }
  async verify(_desired) {
    this._check('verify');
    return { success: true, status: 'UNKNOWN', message: '', details: {} };
  }

  /**
   * Clone a remote URL into a target directory.
   *   url   — git URL (validated against http(s)/ssh/scp schemes)
   *   target — absolute path
   *   ref    — optional branch/tag to check out after clone
   */
  clone(url, target, ref = null) {
    if (!isSafeRemoteUrl(url)) {
      throw new AdapterError(`refusing to clone unsafe URL: ${url}`, {
        code: 'GIT_UNSAFE_URL',
        resource: this.id,
        action: 'clone',
      });
    }
    const args = ['clone', url, target];
    const res = this._runner(args, { allowFail: true });
    if (res.status !== 0) {
      throw new AdapterError(`git clone failed: ${res.stderr || res.stdout}`, {
        code: 'GIT_CLONE_FAILED',
        resource: this.id,
        action: 'clone',
        cause: res,
      });
    }
    if (ref) {
      const checkout = this._runner(['-C', target, 'checkout', ref], { allowFail: true });
      if (checkout.status !== 0) {
        throw new AdapterError(`git checkout ${ref} failed: ${checkout.stderr}`, {
          code: 'GIT_CHECKOUT_FAILED',
          resource: this.id,
          action: 'clone',
        });
      }
    }
    return { ok: true, target, ref };
  }

  /**
   * Fetch the latest refs into an existing clone. Refuses destructive flags.
   */
  fetch(repoPath) {
    const res = this._runner(['-C', repoPath, 'fetch', '--prune', '--tags'], { allowFail: true });
    if (res.status !== 0) {
      throw new AdapterError(`git fetch failed: ${res.stderr}`, {
        code: 'GIT_FETCH_FAILED',
        resource: this.id,
        action: 'fetch',
      });
    }
    return { ok: true };
  }

  /**
   * Read the working-tree status of a clone. Pure read.
   */
  status(repoPath) {
    const res = this._runner(['-C', repoPath, 'status', '--porcelain'], { allowFail: true });
    if (res.status !== 0) {
      throw new AdapterError(`git status failed: ${res.stderr}`, {
        code: 'GIT_STATUS_FAILED',
        resource: this.id,
        action: 'status',
      });
    }
    const lines = (res.stdout || '').split('\n').filter(Boolean);
    return { ok: true, dirty: lines.length > 0, files: lines };
  }

  /**
   * Read current HEAD commit SHA. Pure read.
   */
  headCommit(repoPath) {
    const res = this._runner(['-C', repoPath, 'rev-parse', 'HEAD'], { allowFail: true });
    if (res.status !== 0) {
      throw new AdapterError(`git rev-parse failed: ${res.stderr}`, {
        code: 'GIT_REVPARSE_FAILED',
        resource: this.id,
        action: 'verify',
      });
    }
    return (res.stdout || '').trim();
  }

  /**
   * Force-push is refused by policy. The base class already raises
   * AdapterError via _check; this is here so callers see a stable error
   * code if they reach it directly.
   */
  forcePush() {
    throw new AdapterError('action "force-push" is refused by adapter "git" (M3 safety policy)', {
      code: 'ADAPTER_ACTION_REFUSED',
      resource: this.id,
      action: 'force-push',
    });
  }
  deleteBranch() {
    throw new AdapterError('action "branch-delete" is refused by adapter "git" (M3 safety policy)', {
      code: 'ADAPTER_ACTION_REFUSED',
      resource: this.id,
      action: 'branch-delete',
    });
  }
  resetHard() {
    throw new AdapterError('action "reset-hard" is refused by adapter "git" (M3 safety policy)', {
      code: 'ADAPTER_ACTION_REFUSED',
      resource: this.id,
      action: 'reset-hard',
    });
  }
}

function defaultRunner(executable) {
  return (args, opts = {}) => {
    const proc = spawnSync(executable, args, { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!opts.allowFail && proc.error) throw proc.error;
    return proc;
  };
}

export function isSafeRemoteUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  // Allow git@host:path (ssh shorthand), ssh://, http(s)://, file://, and
  // relative paths starting with "./" or "../" for local clones.
  if (/^(https?|ssh|git|file):\/\//i.test(url)) return true;
  if (/^[\w.-]+@[\w.-]+:/.test(url)) return true; // user@host:path
  if (url.startsWith('./') || url.startsWith('../') || url.startsWith('/')) return true;
  return false;
}


registerAdapter({ id: 'git', kind: 'tool', factory: (opts = {}) => new GitAdapter(opts) });
