// Restore — bring a workspace to the state recorded in the lockfile
// (or, if no lockfile, to the state described by the manifest).
//
// Spec §34 / §22:
//   * Machine A `workbench sync` -> writes lockfile + commits to git
//   * Machine B clean VM: `workbench restore` -> reads manifest, applies,
//     verifies, repeat until`NO CHANGES`
//
// M4 behavior:
//   * Plan derives from the manifest + observed state (probes host).
//   * If a lockfile is present, every applied step's `before` is replaced
//     with the locked version when observed is missing/null — so a clean
//     VM correctly plans SKIP for already-pinned resources.
//   * After apply,`noChanges` is true when summary.applied === 0.
//   * `restoreWorkspace` writes back a refreshed lockfile when desired
//     versions diverge from the lockfile (defensive drift correction).

import fs from 'node:fs';
import path from 'node:path';
import { loadManifest } from './manifest-load.mjs';
import { validateManifest, ManifestError } from './manifest-validate.mjs';
import { applyPlan } from './apply.mjs';
import { planFromManifest } from './plan.mjs';
import { readLockfile, LockfileError } from './lockfile.mjs';
import { buildLockfile, writeLockfile } from './lockfile.mjs';
import { ObservedState } from './state.mjs';
import { NodeAdapter } from '../adapters/node.mjs';
import { PythonAdapter } from '../adapters/python.mjs';
import { UvAdapter } from '../adapters/uv.mjs';
import { ClaudeCodeAdapter } from '../adapters/claude-code.mjs';
import { CodexAdapter } from '../adapters/codex.mjs';
import { StateStore } from './store.mjs';
import { AuditLog } from './audit.mjs';

export class RestoreError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'RestoreError';
    this.code = options.code ?? 'RESTORE_ERROR';
  }
}

export { loadManifest };

/**
 * Build the observed state, but if a lockfile is present, treat locked
 * versions as the "before" baseline — so a clean VM sees SKIP for
 * already-pinned resources instead of spurious INSTALL. Lockfile entries
 * win over observed when both are present.
 */
function observedFromLockfile(observed, lockfile) {
  if (!lockfile || !lockfile.environment) return observed;
  const map = new Map(observed.entries());
  for (const [resource, entry] of Object.entries(lockfile.environment)) {
    // Lockfile wins: even if observed is null, the pinned version is
    // what the workspace was synced to. This is the entire point of the
    // lockfile-as-baseline policy on a clean VM.
    map.set(resource, { resource, version: entry.version, status: 'INSTALLED' });
  }
  return new ObservedState([...map.values()]);
}

export async function planRestore(manifestPath, options = {}) {
  const absolute = path.resolve(manifestPath);
  const manifest = loadManifest(absolute);
  validateManifest(manifest);
  const lockfilePath = path.join(path.dirname(absolute), 'workspace.lock');
  let lockfile = null;
  let lockfileError = null;
  if (fs.existsSync(lockfilePath)) {
    try {
      lockfile = readLockfile(lockfilePath);
    } catch (err) {
      lockfileError = err;
    }
  }
  const adapterMap = options.adapterMap ?? defaultAdapterMap();
  const rawObserved = options.observed ?? await detectObservedState(adapterMap);
  const observed = observedFromLockfile(rawObserved, lockfile);
  const plan = planFromManifest(manifest, observed);
  return { manifest, manifestPath: absolute, lockfilePath, lockfile, lockfileError, plan, adapterMap, observed };
}

export async function applyRestore(planReport, options = {}) {
  const apply = options.apply !== false;
  const adapterMap = options.adapterMap ?? planReport.adapterMap ?? defaultAdapterMap();
  const audit = options.audit ?? null;
  const stateStore = options.stateStore ?? null;
  return applyPlan(planReport.plan, adapterMap, { apply, audit, stateStore });
}

export async function restoreWorkspace(manifestPath, options = {}) {
  const planned = await planRestore(manifestPath, options);
  const applyOptions = { apply: options.apply !== false, adapterMap: planned.adapterMap };
  if (options.audit) applyOptions.audit = options.audit;
  if (options.stateStore) applyOptions.stateStore = options.stateStore;
  const report = await applyRestore(planned, applyOptions);

  // Defensive: refresh the lockfile if the desired versions no longer
  // match the lockfile (lockfile drift). The refresh only happens when
  // apply is true (i.e. mutation is allowed); dry-run restores are
  // observation-only.
  const mutate = options.apply !== false;
  let refreshedLockfile = null;
  if (mutate && report.summary.failed === 0 && planned.lockfile) {
    const drifted = Object.entries(planned.manifest.environment).some(([resource, entry]) => {
      const locked = planned.lockfile.environment?.[resource];
      return locked && locked.version !== entry.version;
    });
    if (drifted) {
      const next = buildLockfile({
        workspaceId: planned.manifest.workspace.id,
        appliedState: report.appliedState,
        agents: planned.manifest.agents ?? [],
        mcp: planned.manifest.mcp ?? [],
        projects: options.projectReport?.projects ?? [],
        source: 'restore',
      });
      writeLockfile(planned.lockfilePath, next);
      refreshedLockfile = planned.lockfilePath;
      if (options.audit) options.audit.lockfileWritten(planned.lockfilePath);
    }
  }

  return {
    workspace: planned.manifest.workspace.id,
    manifestPath: planned.manifestPath,
    lockfilePath: planned.lockfilePath,
    lockfile: planned.lockfile,
    lockfileError: planned.lockfileError,
    noChanges: report.summary.applied === 0 && report.summary.failed === 0,
    report,
    refreshedLockfile,
  };
}

async function detectObservedState(adapters) {
  const entries = [];
  for (const [, adapter] of adapters.entries()) {
    try {
      entries.push(await adapter.detect());
    } catch (err) {
      entries.push({ resource: adapter.id, version: null, status: 'ERROR', details: { error: err.message } });
    }
  }
  return new ObservedState(entries);
}

function defaultAdapterMap() {
  const map = new Map();
  map.set('node', new NodeAdapter());
  map.set('python', new PythonAdapter());
  map.set('uv', new UvAdapter());
  map.set('claude-code', new ClaudeCodeAdapter());
  map.set('codex', new CodexAdapter());
  return map;
}

export { ManifestError, LockfileError, StateStore, AuditLog };
