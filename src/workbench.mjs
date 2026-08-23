#!/usr/bin/env node
// Workspace Core CLI — thin caller of core/ functions.
//
// M1+M2+M3: loads workspace.json, plans an execution, routes through
// environment + agent + git adapters, applies (or previews) the result.
//
// All mutation is opt-in: `apply` defaults to dry-run; pass --apply to
// mutate. The Core API lives under core/*; this file is just IO + CLI.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ObservedState,
  ResourceState,
  KNOWN_ENVIRONMENT_RESOURCES,
  diffResource,
  AppliedState,
  AppliedStep,
} from '../core/state.mjs';
import {
  ManifestError,
  validateManifest,
  VALID_ID,
  VALID_VERSION,
} from '../core/manifest-validate.mjs';
import { loadManifest } from '../core/manifest-load.mjs';
import { planFromManifest } from '../core/plan.mjs';
import { applyPlan } from '../core/apply.mjs';
import { ProjectManager } from '../core/projects.mjs';
import { AgentRegistry } from '../core/agents.mjs';
import { McpRegistry } from '../core/mcp.mjs';
import { PackageRegistry } from '../core/packages.mjs';
import { NodeAdapter } from '../adapters/node.mjs';
import { PythonAdapter } from '../adapters/python.mjs';
import { UvAdapter } from '../adapters/uv.mjs';
import { ClaudeCodeAdapter } from '../adapters/claude-code.mjs';
import { CodexAdapter } from '../adapters/codex.mjs';
import { GitAdapter } from '../adapters/git.mjs';

// ---------- Back-compat re-exports ---------------------------------------
//
// The pure Core API lives under core/*. The src/ module is intentionally a
// thin CLI shell; tests that already import from src/ keep working through
// these re-exports. Prefer importing from core/ in new code.

export {
  ManifestError,
  ObservedState,
  ResourceState,
  KNOWN_ENVIRONMENT_RESOURCES,
  diffResource,
  VALID_ID,
  VALID_VERSION,
  validateManifest,
  loadManifest,
  planFromManifest,
};

// Back-compat alias used by older tests / call-sites.
export function planFromYaml(yamlText, observed) {
  return planFromManifest(JSON.parse(yamlText), observed);
}

// ---------- Registries & adapter construction ----------------------------

export function createEnvironmentAdapters(options = {}) {
  const map = new Map();
  if (options.adapters) {
    for (const [name, adapter] of Object.entries(options.adapters)) {
      map.set(name, adapter);
    }
    return map;
  }
  map.set('node', new NodeAdapter(options.node ?? {}));
  map.set('python', new PythonAdapter(options.python ?? {}));
  map.set('uv', new UvAdapter(options.uv ?? {}));
  return map;
}

export function createAgentAdapters(options = {}) {
  const map = new Map();
  if (options.adapters) {
    for (const [name, adapter] of Object.entries(options.adapters)) {
      map.set(name, adapter);
    }
    return map;
  }
  map.set('claude-code', new ClaudeCodeAdapter(options['claude-code'] ?? {}));
  map.set('codex', new CodexAdapter(options.codex ?? {}));
  return map;
}

function buildRegistries(manifest, options = {}) {
  const agents = options.agents instanceof AgentRegistry ? options.agents : new AgentRegistry();
  agents.applyManifest(manifest.agents);
  const mcp = options.mcp instanceof McpRegistry ? options.mcp : new McpRegistry();
  mcp.applyManifest(manifest.mcp);
  const packages = options.packages instanceof PackageRegistry ? options.packages : new PackageRegistry();
  packages.applyManifest(manifest.packages);
  return { agents, mcp, packages };
}

// ---------- CLI surface ----------------------------------------------------

function resolveManifestPath(argv, cwd = process.cwd()) {
  const index = argv.indexOf('--manifest');
  if (index >= 0) {
    const explicit = argv[index + 1];
    if (!explicit) {
      throw new ManifestError('--manifest requires a path argument', {
        code: 'CLI_ARG_MISSING',
        field: '--manifest',
      });
    }
    return path.resolve(explicit);
  }
  for (const candidate of ['workspace.json', 'workspace.yaml']) {
    const full = path.resolve(cwd, candidate);
    if (fs.existsSync(full)) return full;
  }
  throw new ManifestError(
    `no manifest found: pass --manifest <path> or create workspace.json in ${cwd}`,
    { code: 'MANIFEST_NOT_FOUND', field: '--manifest' }
  );
}

function envObservedState() {
  const values = {};
  for (const resource of KNOWN_ENVIRONMENT_RESOURCES) {
    const raw = process.env[`WORKBENCH_${resource.toUpperCase()}_VERSION`];
    values[resource] = raw == null || raw === '' ? null : raw;
  }
  return new ObservedState(values);
}

async function detectObservedState(adapters) {
  const entries = [];
  for (const [resource, adapter] of adapters.entries()) {
    let state;
    try {
      state = await adapter.detect();
    } catch (err) {
      state = new ResourceState({ resource, version: null, status: 'ERROR', details: { error: err.message } });
    }
    entries.push(state);
  }
  return new ObservedState(entries);
}

function formatStep(step, index) {
  const head = `${index + 1} ${step.action} ${step.resource}`;
  if (step.action === 'UPDATE') return `${head} ${step.previous} → ${step.version}`;
  return `${head} ${step.version}`;
}

function formatApplyStep(step, index) {
  const head = `${index + 1} ${step.status} ${step.resource}`;
  const after = step.after ?? '?';
  let tail;
  if (step.status === 'PREVIEW') {
    tail = `(dry-run) ${step.action} ${step.before ?? '?'} → ${after}`;
  } else if (step.status === 'NO_CHANGE' && step.action === 'SKIP') {
    tail = `${step.action} ${after}`;
  } else if (step.status === 'NO_CHANGE') {
    tail = `${step.action} ${after} (no change)`;
  } else if (step.status === 'BLOCKED') {
    tail = `${step.action} ${after} (blocked: ${step.message || 'dependency failed'})`;
  } else if (step.status === 'FAILED') {
    tail = `${step.action} ${after} (failed: ${step.message || 'unknown'})`;
  } else {
    tail = `${step.action}${step.before != null && step.after != null && step.before !== step.after ? ` ${step.before} → ${step.after}` : ` ${after}`}`;
  }
  return `${head} ${tail}`;
}

// One shared error formatter for every command. The CLI repeats this
// block 9 times without it; centralizing ensures consistent output.
function reportManifestError(err, stderr) {
  stderr.write(`workbench: ${err.message}\n`);
  if (err.field) stderr.write(`  field: ${err.field}\n`);
  return 1;
}

function printHelp(stdout = process.stdout) {
  stdout.write(`workbench — M1/M2/M3/M4 workspace runtime

Usage:
  workbench plan [--manifest PATH]            Preview install/update/skip steps.
  workbench apply [--manifest PATH] [--apply] Dry-run by default; --apply mutates.
  workbench verify [--manifest PATH]          Re-detect and show workspace health.
  workbench sync [--manifest PATH] [--apply] [--no-git] Snapshot + lockfile + project sync.
  workbench restore [--manifest PATH] [--apply] Re-apply manifest + lockfile (lockfile-priority).
  workbench rollback --to <snapshotId>        Restore managed files from a snapshot.
  workbench init [--manifest PATH]            Generate a starter workspace.json.
  workbench status [--manifest PATH]          Show current vs desired state.
  workbench project list [--manifest PATH]    List declared projects.
  workbench agent list [--manifest PATH]      List declared agents.
  workbench mcp list [--manifest PATH]        List declared MCP servers.
  workbench package list [--manifest PATH]    List declared packages.
  workbench --help                            Show this help.

Default manifest lookup: workspace.json, then workspace.yaml in cwd.

Exit codes:
  0  success or help
  1  manifest error (parse, validation, missing)
  2  unknown command
  3  YAML manifest (M2 does not parse YAML)
  4  apply step failed
`);
}

async function runPlan(argv, stdout, stderr, cwd) {
  let manifestPath;
  try {
    manifestPath = resolveManifestPath(argv, cwd);
    if (manifestPath.endsWith('.yaml') || manifestPath.endsWith('.yml')) {
      stderr.write(`workbench: M2 does not parse YAML manifests (${manifestPath}). Use workspace.json or convert the file to JSON. YAML support lands in a later milestone.\n`);
      return 3;
    }
  } catch (err) {
    if (err instanceof ManifestError) {
      return reportManifestError(err, stderr);
    }
    throw err;
  }
  let loaded;
  try {
    const manifest = loadManifest(manifestPath);
    validateManifest(manifest);
    const observed = envObservedState();
    loaded = { manifest, plan: planFromManifest(manifest, observed), observed };
  } catch (err) {
    if (err instanceof ManifestError) {
      return reportManifestError(err, stderr);
    }
    throw err;
  }
  stdout.write(`Workspace: ${loaded.plan.workspace}\n`);
  for (const [i, step] of loaded.plan.steps.entries()) stdout.write(`${formatStep(step, i)}\n`);
  return 0;
}

async function loadManifestWithRegistries(manifestPath) {
  const manifest = loadManifest(manifestPath);
  validateManifest(manifest);
  const { agents, mcp, packages } = buildRegistries(manifest);
  return { manifest, agents, mcp, packages };
}

async function runApply(argv, stdout, stderr, cwd) {
  let manifestPath;
  try {
    manifestPath = resolveManifestPath(argv, cwd);
    if (manifestPath.endsWith('.yaml') || manifestPath.endsWith('.yml')) {
      stderr.write(`workbench: M2 does not parse YAML manifests (${manifestPath}). Use workspace.json or convert the file to JSON. YAML support lands in a later milestone.\n`);
      return 3;
    }
  } catch (err) {
    if (err instanceof ManifestError) {
      return reportManifestError(err, stderr);
    }
    throw err;
  }
  const applyFlag = argv.includes('--apply');
  let loaded;
  try {
    loaded = await loadManifestWithRegistries(manifestPath);
    const adapters = createEnvironmentAdapters();
    const observed = await detectObservedState(adapters);
    const plan = planFromManifest(loaded.manifest, observed);
    const report = await applyPlan(plan, adapters, { apply: applyFlag });
    stdout.write(`Workspace: ${report.workspace}\n`);
    stdout.write(`Mode: ${report.dryRun ? 'dry-run' : 'apply'}\n`);
    for (const [i, step] of report.steps.entries()) stdout.write(`${formatApplyStep(step, i)}\n`);
    stdout.write(`Summary: applied=${report.summary.applied} noChange=${report.summary.noChange} blocked=${report.summary.blocked ?? 0} failed=${report.summary.failed}\n`);
    if (report.error) {
      stderr.write(`workbench: apply failed — ${report.error.message}\n`);
      return 4;
    }
    return 0;
  } catch (err) {
    if (err instanceof ManifestError) {
      return reportManifestError(err, stderr);
    }
    throw err;
  }
}

async function runVerify(argv, stdout, stderr, cwd) {
  let manifestPath;
  try { manifestPath = resolveManifestPath(argv, cwd); } catch (err) {
    if (err instanceof ManifestError) { return reportManifestError(err, stderr); }
    throw err;
  }
  let loaded;
  try {
    loaded = await loadManifestWithRegistries(manifestPath);
  } catch (err) {
    if (err instanceof ManifestError) { return reportManifestError(err, stderr); }
    throw err;
  }
  stdout.write(`Workspace: ${loaded.manifest.workspace.id}\n`);
  stdout.write(`Health: PASS (manifest validated)\n`);
  stdout.write(`Resources: ${Object.keys(loaded.manifest.environment).join(', ')}\n`);
  stdout.write(`Projects: ${(loaded.manifest.projects ?? []).length}\n`);
  stdout.write(`Agents: ${(loaded.manifest.agents ?? []).map((a) => a.id).join(', ') || '(builtins: claude-code, codex)'}\n`);
  stdout.write(`MCP: ${(loaded.manifest.mcp ?? []).map((m) => m.id).join(', ') || '(none)'}\n`);
  stdout.write(`Packages: ${(loaded.manifest.packages ?? []).length}\n`);
  return 0;
}

async function runSync(argv, stdout, stderr, cwd) {
  let manifestPath;
  try { manifestPath = resolveManifestPath(argv, cwd); } catch (err) {
    if (err instanceof ManifestError) { return reportManifestError(err, stderr); }
    throw err;
  }
  const applyFlag = argv.includes('--apply');
  // --no-git disables network git clones (set git.executable=false so the
  // GitAdapter skips real git invocations). Local project directories are
  // still created under --apply. --skip-projects is the explicit kill
  // switch that suppresses every project action.
  const skipGit = argv.includes('--no-git');
  const gitOptions = skipGit ? { executable: false } : {};
  const { syncWorkspace } = await import('../core/sync.mjs');
  let result;
  try {
    result = await syncWorkspace(manifestPath, {
    apply: applyFlag,
    gitOptions,
    skipAllProjects: argv.includes('--skip-projects'),
    continueOnError: argv.includes('--continue-on-error'),
  });
  } catch (err) {
    if (err instanceof ManifestError) { return reportManifestError(err, stderr); }
    throw err;
  }
  stdout.write(`Workspace: ${result.workspace}\n`);
  stdout.write(`Mode: ${result.dryRun ? 'dry-run' : 'apply'}\n`);
  if (result.snapshot) stdout.write(`Snapshot: ${result.snapshot.id}\n`);
  if (result.lockfileWritten) stdout.write(`Lockfile: ${result.lockfileWritten}\n`);
  for (const [i, step] of result.report.steps.entries()) stdout.write(`${formatApplyStep(step, i)}\n`);
  stdout.write(`Summary: applied=${result.report.summary.applied} noChange=${result.report.summary.noChange} blocked=${result.report.summary.blocked ?? 0} failed=${result.report.summary.failed}\n`);
  if (result.projectReport) stdout.write(`Projects: ${result.projectReport.summary.synced} synced, ${result.projectReport.summary.failed} failed\n`);
  if (result.report.error) {
    stderr.write(`workbench: sync failed — ${result.report.error.message}\n`);
    return 4;
  }
  return 0;
}

async function runRestore(argv, stdout, stderr, cwd) {
  let manifestPath;
  try { manifestPath = resolveManifestPath(argv, cwd); } catch (err) {
    if (err instanceof ManifestError) { return reportManifestError(err, stderr); }
    throw err;
  }
  const applyFlag = argv.includes('--apply');
  // Delegate to core/restore.mjs so the CLI and any future programmatic
  // caller share the exact same pipeline.
  const { restoreWorkspace } = await import('../core/restore.mjs');
  let result;
  try {
    result = await restoreWorkspace(manifestPath, { apply: applyFlag });
  } catch (err) {
    if (err instanceof ManifestError) { return reportManifestError(err, stderr); }
    throw err;
  }
  stdout.write(`Workspace: ${result.workspace}\n`);
  stdout.write(`Mode: ${result.report.dryRun ? 'dry-run' : 'apply'}\n`);
  for (const [i, step] of result.report.steps.entries()) stdout.write(`${formatApplyStep(step, i)}\n`);
  if (result.noChanges) stdout.write(`Result: NO CHANGES\n`);
  if (result.report.error) {
    stderr.write(`workbench: restore failed — ${result.report.error.message}\n`);
    return 4;
  }
  return 0;
}

function runInit(argv, stdout, stderr, cwd) {
  const target = path.resolve(cwd, 'workspace.json');
  if (fs.existsSync(target)) {
    stderr.write(`workbench: workspace.json already exists at ${target}\n`);
    return 1;
  }
  const skeleton = {
    version: '1',
    workspace: { id: path.basename(cwd).replace(/[^A-Za-z0-9._-]/g, '-') || 'my-workspace', name: path.basename(cwd) },
    environment: { node: { version: '22' }, python: { version: '3.12' }, uv: { version: 'latest' } },
    projects: [],
    agents: [],
    mcp: [],
    settings: { auto_update: false, verify_after_apply: true },
  };
  fs.writeFileSync(target, JSON.stringify(skeleton, null, 2), 'utf8');
  stdout.write(`wrote ${target}\n`);
  return 0;
}

async function runStatus(argv, stdout, stderr, cwd) {
  let manifestPath;
  try { manifestPath = resolveManifestPath(argv, cwd); } catch (err) {
    if (err instanceof ManifestError) { return reportManifestError(err, stderr); }
    throw err;
  }
  let loaded;
  try { loaded = await loadManifestWithRegistries(manifestPath); } catch (err) {
    if (err instanceof ManifestError) { return reportManifestError(err, stderr); }
    throw err;
  }
  const adapters = createEnvironmentAdapters();
  const observed = await detectObservedState(adapters);
  stdout.write(`Workspace: ${loaded.manifest.workspace.id}\n`);
  stdout.write(`Observed:\n`);
  for (const [, adapter] of adapters.entries()) {
    const state = observed.get(adapter.id);
    if (!state) continue;
    stdout.write(`  ${state.resource}: ${state.version ?? '<missing>'} (${state.status})\n`);
  }
  const plan = planFromManifest(loaded.manifest, observed);
  stdout.write(`Plan: ${plan.steps.length} step(s)\n`);
  for (const [i, step] of plan.steps.entries()) stdout.write(`  ${formatStep(step, i)}\n`);
  return 0;
}

async function runList(argv, stdout, stderr, cwd, kind) {
  let manifestPath;
  try { manifestPath = resolveManifestPath(argv, cwd); } catch (err) {
    if (err instanceof ManifestError) { return reportManifestError(err, stderr); }
    throw err;
  }
  let loaded;
  try { loaded = await loadManifestWithRegistries(manifestPath); } catch (err) {
    if (err instanceof ManifestError) { return reportManifestError(err, stderr); }
    throw err;
  }
  if (kind === 'project') {
    const projects = loaded.manifest.projects ?? [];
    stdout.write(`Projects (${projects.length}):\n`);
    for (const p of projects) stdout.write(`  ${p.id}: ${p.source?.type ?? '?'}${p.path ? ` @ ${p.path}` : ''}\n`);
  } else if (kind === 'agent') {
    const registry = loaded.agents;
    const declared = new Set((loaded.manifest.agents ?? []).map((a) => a.id));
    const lines = [];
    for (const a of registry.list()) {
      const tag = declared.has(a.id) ? '(declared)' : '(builtin)';
      lines.push(`  ${a.id} ${tag}: provider=${a.provider}, capabilities=[${a.capabilities.join(', ')}]`);
    }
    stdout.write(`Agents (${lines.length}):\n${lines.join('\n')}\n`);
  } else if (kind === 'mcp') {
    const mcps = loaded.mcp.list();
    stdout.write(`MCP (${mcps.length}):\n`);
    for (const m of mcps) stdout.write(`  ${m.id}: ${m.transport}${m.enabled === false ? ' [disabled]' : ''}\n`);
  } else if (kind === 'package') {
    const pkgs = loaded.packages.list();
    stdout.write(`Packages (${pkgs.length}):\n`);
    for (const p of pkgs) stdout.write(`  ${p.id}: ${p.type}@${p.version}\n`);
  }
  return 0;
}

async function runRollback(argv, stdout, stderr, cwd) {
  const toIdx = argv.indexOf('--to');
  const snapId = toIdx >= 0 ? argv[toIdx + 1] : null;
  if (!snapId) {
    stderr.write(`workbench: rollback requires --to <snapshotId>\n`);
    return 1;
  }
  const { rollbackToSnapshot, listSnapshotsFor } = await import('../core/rollback.mjs');
  const list = listSnapshotsFor(cwd);
  if (list.length === 0) {
    stderr.write(`workbench: no snapshots in ${cwd}/.workbench/snapshots\n`);
    return 1;
  }
  const found = list.find((s) => s.id === snapId);
  if (!found) {
    stderr.write(`workbench: snapshot "${snapId}" not found (available: ${list.map((s) => s.id).join(', ')})\n`);
    return 1;
  }
  try {
    const restored = await rollbackToSnapshot(snapId, { root: cwd, workspaceId: path.basename(cwd) });
    stdout.write(`Rolled back to ${restored.snapshotId}: ${restored.restored.length} file(s) restored\n`);
    return 0;
  } catch (err) {
    stderr.write(`workbench: rollback failed — ${err.message}\n`);
    return 4;
  }
}

export async function run(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr, cwd = process.cwd()) {
  const [command, subcommand, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    printHelp(stdout);
    return 0;
  }
  try {
    if (command === 'plan') return await runPlan(argv, stdout, stderr, cwd);
    if (command === 'apply') return await runApply(argv, stdout, stderr, cwd);
    if (command === 'verify') return await runVerify(argv, stdout, stderr, cwd);
    if (command === 'sync') return await runSync(argv, stdout, stderr, cwd);
    if (command === 'restore') return await runRestore(argv, stdout, stderr, cwd);
    if (command === 'rollback') return await runRollback(argv, stdout, stderr, cwd);
    if (command === 'init') return runInit(argv, stdout, stderr, cwd);
    if (command === 'status') return await runStatus(argv, stdout, stderr, cwd);
    if (command === 'project' && subcommand === 'list') return await runList(rest, stdout, stderr, cwd, 'project');
    if (command === 'agent' && subcommand === 'list') return await runList(rest, stdout, stderr, cwd, 'agent');
    if (command === 'mcp' && subcommand === 'list') return await runList(rest, stdout, stderr, cwd, 'mcp');
    if (command === 'package' && subcommand === 'list') return await runList(rest, stdout, stderr, cwd, 'package');
    stderr.write(`workbench: unknown command "${command}"\n`);
    return 2;
  } catch (err) {
    if (err instanceof ManifestError) {
      return reportManifestError(err, stderr);
    }
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(
    (code) => { if (code !== 0) process.exit(code); },
    (err) => { process.stderr.write(`workbench: unexpected error: ${err.stack || err.message}\n`); process.exit(1); }
  );
}