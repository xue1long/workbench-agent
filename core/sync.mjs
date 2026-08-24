// Workspace Sync — the "Machine A → git" half of the M4 E2E.
//
// Spec §34: workbench sync produces a Workspace Repository that includes
// `workspace.json`, `workspace.lock`, and the project sources.
//
// Sync writes:
//   * `workspace.lock` from a verified applied state
//   * snapshots of any managed config files (`createSnapshot`)
//   * audit records (`AuditLog`)

import fs from 'node:fs';
import path from 'node:path';
import { buildLockfile, writeLockfile } from './lockfile.mjs';
import { createSnapshot } from './snapshot.mjs';
import { loadManifest } from './manifest-load.mjs';
import { validateManifest, ManifestError } from './manifest-validate.mjs';
import { ProjectManager } from './projects.mjs';
import { getAdapter } from './adapters.mjs';
import { ObservedState } from './state.mjs';
import { StateStore } from './store.mjs';
import { AuditLog } from './audit.mjs';
import { applyPlan } from './apply.mjs';
import { planFromManifest } from './plan.mjs';

// Side-effect import: registers concrete adapters with the registry in
// core/adapters.mjs. Required because getAdapter() throws on unknown ids
// until adapters/index.js has been loaded.
import '../adapters/index.js';

export class SyncError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SyncError';
    this.code = options.code ?? 'SYNC_ERROR';
  }
}

export async function syncWorkspace(manifestPath, options = {}) {
  const manifestAbsolute = path.resolve(manifestPath);
  const manifest = loadManifest(manifestAbsolute);
  validateManifest(manifest);
  const workspaceId = manifest.workspace.id;
  const root = path.dirname(manifestAbsolute);
  const stateStore = options.stateStore ?? new StateStore({ workspaceId });
  const audit = options.audit ?? new AuditLog({ workspaceId, store: stateStore });
  const apply = options.apply !== false;
  const dryRun = !apply;

  const adapters = options.adapterMap ?? defaultAdapterMap();
  const observed = options.observed ?? await detectObserved(adapters);
  for (const [, adapter] of adapters.entries()) {
    const state = observed.get(adapter.id);
    if (state) audit.resourceObserved(adapter.id, { version: state.version, status: state.status });
  }

  // Snapshot managed config files before mutation. Defaults: manifest,
  // any agent configPaths, and the existing lockfile.
  const managedPaths = [manifestAbsolute];
  if (Array.isArray(manifest.agents)) {
    for (const a of manifest.agents) {
      if (Array.isArray(a.configPaths)) managedPaths.push(...a.configPaths);
    }
  }
  const existingLockfile = path.join(root, 'workspace.lock');
  if (fs.existsSync(existingLockfile)) managedPaths.push(existingLockfile);

  let snapshot = null;
  if (!dryRun) {
    snapshot = createSnapshot(managedPaths, { root, id: `sync-${Date.now()}` });
    audit.snapshotCreated(snapshot);
  }

  const plan = planFromManifest(manifest, observed);
  const report = await applyPlan(plan, adapters, { apply, audit, stateStore });

  // Sync projects FIRST. Only after projects succeed do we write the
  // lockfile — otherwise a failed clone would commit a lockfile that lies
  // about the synced project state (spec §34). `continueOnError` is
  // decoupled from the `apply` flag: project-sync failures don't cascade
  // by default; callers can opt in via `--continue-on-error`.
  let projectReport = null;
  if (!options.skipAllProjects) {
    const projects = manifest.projects ?? [];
    if (projects.length > 0) {
      const git = options.git ?? getAdapter('git', options.gitOptions ?? {});
      const pm = new ProjectManager({ git });
      projectReport = pm.sync(projects, root, { continueOnError: options.continueOnError === true });
    }
  }

  // Write the lockfile only when both apply succeeded AND projects succeeded
  // (or were skipped). Lockfile records what is actually on disk, not what
  // the engine planned.
  const projectsFailed = projectReport && projectReport.summary.failed > 0;
  let lockfileWritten = null;
  if (!dryRun && report.summary.failed === 0 && !projectsFailed) {
    const lockfile = buildLockfile({
      workspaceId,
      appliedState: report.appliedState,
      agents: manifest.agents ?? [],
      mcp: manifest.mcp ?? [],
      projects: projectReport?.projects ?? [],
      source: 'sync',
    });
    writeLockfile(existingLockfile, lockfile);
    lockfileWritten = existingLockfile;
    audit.lockfileWritten(existingLockfile);
  }

  return {
    workspace: workspaceId,
    root,
    manifestPath: manifestAbsolute,
    dryRun,
    noChanges: report.summary.applied === 0 && report.summary.failed === 0,
    snapshot,
    report,
    lockfileWritten,
    projectReport,
  };
}

async function detectObserved(adapters) {
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
  map.set('node', getAdapter('node'));
  map.set('python', getAdapter('python'));
  map.set('uv', getAdapter('uv'));
  return map;
}

export { ManifestError };
