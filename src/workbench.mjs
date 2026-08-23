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
import { spawnSync } from 'node:child_process';

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
  workbench pipeline list                     List pipeline templates.
  workbench pipeline simulate --template <id> --goal <text>  Compile a template (no execution).
  workbench pipeline status --pipeline-id <id> --run-id <id>  Show stage states for a run.
  workbench pipeline run --template <id> --goal <text> [--resume-run <id>] [--approve-changes]  Run a pipeline.
  workbench knowledge ingest --dir <path> --scope <scope> [--kind markdown|code]  Ingest repo files.
  workbench knowledge retrieve --query <text> --scope <scope> [--budget N]  Scoped retrieval.
  workbench knowledge benchmark [--fixture <dir>] [--queries <json>]  Fixed retrieval benchmark.
  workbench memory list [--scope <scope>]     List durable project memory entries.
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

function printTaskHelp(stdout) {
  stdout.write(`Usage: workbench task <command> [options]\n\nCommands:\n  validate --file <path>          Validate a TaskGraph JSON file\n  simulate --file <path> [--concurrency N]    Simulate execution\n  run --goal <text> [--concurrency N] [--approve-changes]    Run a governed task\n`);
  return 0;
}

async function loadTaskFromFile(pathArg) {
  if (!fs.existsSync(pathArg)) {
    throw new Error(`task file not found: ${pathArg}`);
  }
  return JSON.parse(fs.readFileSync(pathArg, 'utf8'));
}

async function runTaskValidate(rest, stdout, stderr, cwd) {
  const fileIdx = rest.indexOf('--file');
  if (fileIdx < 0) {
    stderr.write('workbench task validate requires --file <path>\n');
    return 2;
  }
  try {
    const { createTaskGraph } = await import('../core/task-graph.mjs');
    const payload = await loadTaskFromFile(rest[fileIdx + 1]);
    const graph = createTaskGraph(payload);
    stdout.write(`task graph ok: ${graph.nodes.length} node(s)\n`);
    return 0;
  } catch (err) {
    stderr.write(`task validation failed: ${err.message}\n`);
    return 2;
  }
}

async function runTaskSimulate(rest, stdout, stderr, cwd) {
  const fileIdx = rest.indexOf('--file');
  if (fileIdx < 0) {
    stderr.write('workbench task simulate requires --file <path>\n');
    return 2;
  }
  let concurrency = 1;
  const cIdx = rest.indexOf('--concurrency');
  if (cIdx >= 0) {
    const v = Number.parseInt(rest[cIdx + 1], 10);
    if (!Number.isInteger(v) || v < 1 || v > 16) {
      stderr.write('workbench task simulate --concurrency must be an integer in [1,16]\n');
      return 2;
    }
    concurrency = v;
  }
  try {
    const { createTaskGraph } = await import('../core/task-graph.mjs');
    const { executeWorkflow } = await import('../core/workflow-runtime.mjs');
    const payload = await loadTaskFromFile(rest[fileIdx + 1]);
    const graph = createTaskGraph(payload);
    const report = await executeWorkflow(graph, async (node) => ({ success: true, output: { id: node.id }, evidenceClaims: [], cost: 0, usage: {}, message: 'simulated' }), { concurrency });
    stdout.write(`executionStatus: ${report.executionStatus}\nnodes: ${Object.keys(report.nodes).length}\ncost: ${report.cost}\n`);
    return report.executionStatus === 'EXECUTION_SUCCEEDED' ? 0 : 1;
  } catch (err) {
    stderr.write(`task simulation failed: ${err.message}\n`);
    return 1;
  }
}

async function runPipelineList(rest, stdout, stderr) {
  try {
    const { pipelineTemplates } = await import('../core/pipeline-templates.mjs');
    for (const t of pipelineTemplates.list()) {
      stdout.write(`pipeline: ${t.id} v${t.version}\n  stages: ${t.stageIds.join(' → ')}\n`);
    }
    return 0;
  } catch (err) {
    stderr.write(`pipeline list failed: ${err.message}\n`);
    return 1;
  }
}

async function runPipelineSimulate(rest, stdout, stderr) {
  const tIdx = rest.indexOf('--template');
  const gIdx = rest.indexOf('--goal');
  if (tIdx < 0 || gIdx < 0) {
    stderr.write('workbench pipeline simulate requires --template <id> --goal <text>\n');
    return 2;
  }
  try {
    const { pipelineTemplates } = await import('../core/pipeline-templates.mjs');
    const { compilePipeline } = await import('../core/pipeline.mjs');
    const template = pipelineTemplates.get(rest[tIdx + 1]);
    if (!template) {
      stderr.write(`unknown pipeline template ${rest[tIdx + 1]}\n`);
      return 2;
    }
    const graph = compilePipeline(template, { id: 'sim', goal: rest[gIdx + 1] });
    stdout.write(`pipeline: ${template.id} v${template.version} (simulated, no execution)\n`);
    for (const node of graph.nodes) {
      stdout.write(`  ${node.id} [${node.kind}] deps=${node.dependencies.join(',') || '-'} acceptance=${node.acceptanceCriteria.map((a) => a.verifierRef).join(',')}\n`);
    }
    return 0;
  } catch (err) {
    stderr.write(`pipeline simulation failed: ${err.message}\n`);
    return 1;
  }
}

async function runPipelineStatus(rest, stdout, stderr, cwd) {
  const pIdx = rest.indexOf('--pipeline-id');
  const rIdx = rest.indexOf('--run-id');
  if (pIdx < 0 || rIdx < 0) {
    stderr.write('workbench pipeline status requires --pipeline-id <id> --run-id <id>\n');
    return 2;
  }
  try {
    const { StateStore } = await import('../core/store.mjs');
    const { pipelineRunStatus } = await import('../core/pipeline-runner.mjs');
    const store = StateStore.open('default', { root: path.join(cwd, '.workbench', 'store') });
    const status = pipelineRunStatus(store, rest[pIdx + 1], rest[rIdx + 1]);
    if (Object.keys(status.stages).length === 0) {
      stderr.write(`no stage records for pipeline ${status.pipelineId} run ${status.runId}\n`);
      return 1;
    }
    for (const [stageId, stage] of Object.entries(status.stages)) {
      stdout.write(`${stageId}: ${stage.status} artifacts=${Object.keys(stage.artifactHashes).length}\n`);
    }
    return 0;
  } catch (err) {
    stderr.write(`pipeline status failed: ${err.message}\n`);
    return 1;
  }
}

async function runPipelineRun(rest, stdout, stderr, cwd, injected = null) {
  const tIdx = rest.indexOf('--template');
  const gIdx = rest.indexOf('--goal');
  if (tIdx < 0 || gIdx < 0) {
    stderr.write('workbench pipeline run requires --template <id> --goal <text>\n');
    return 2;
  }
  const templateId = rest[tIdx + 1];
  const goal = rest[gIdx + 1];
  const approve = rest.includes('--approve-changes');
  const resumeIdx = rest.indexOf('--resume-run');
  const resumeRunId = resumeIdx >= 0 ? rest[resumeIdx + 1] : null;
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    stderr.write('workbench pipeline run requires a Git working copy\n');
    return 2;
  }
  try {
    const { createTask } = await import('../core/task-graph.mjs');
    const { pipelineTemplates } = await import('../core/pipeline-templates.mjs');
    const { Orchestrator } = await import('../core/orchestrator.mjs');
    const { StateStore } = await import('../core/store.mjs');
    const { createPipelineRunner } = await import('../core/pipeline-runner.mjs');
    const template = pipelineTemplates.get(templateId);
    if (!template) {
      stderr.write(`unknown pipeline template ${templateId}\n`);
      return 2;
    }
    const task = createTask({ id: `pipeline-${Date.now()}`, goal });
    const store = injected?.store ?? StateStore.open('default', { root: path.join(cwd, '.workbench', 'store') });
    let orchestrator;
    if (injected?.orchestrator) {
      orchestrator = injected.orchestrator;
    } else {
      const { DevflowRuntimeAdapter } = await import('../adapters/devflow-runtime.mjs');
      const { ProcessAgentInvoker } = await import('../adapters/process-agent.mjs');
      const { AgentRegistry } = await import('../core/agents.mjs');
      const { createChangeSandbox, collectChangeSet } = await import('../core/change-sandbox.mjs');
      const { createTaskGraph } = await import('../core/task-graph.mjs');
      const placeholder = createTaskGraph({
        task,
        nodes: [{ id: 'p', goal: 'placeholder', acceptanceCriteria: [{ id: 'pa', verifierRef: 'diff', required: true }] }],
      });
      const deps = await buildLiveTaskDeps({
        cwd, goal, graph: placeholder, registry: new AgentRegistry(), approve, stderr,
        DevflowRuntimeAdapter, ProcessAgentInvoker, createChangeSandbox, collectChangeSet,
      });
      orchestrator = new Orchestrator(deps);
    }
    const runner = createPipelineRunner({
      orchestrator,
      store,
      artifactsRoot: injected?.artifactsRoot ?? path.join(cwd, '.workbench', 'pipelines'),
    });
    const report = await runner.run({
      template,
      task,
      resumeRunId,
      approveChangeSet: approve
        ? (cs) => ({ approved: true, actor: 'cli', reason: 'go', changeSetSha256: cs.patchSha256 })
        : () => ({ approved: false }),
    });
    stdout.write(`pipeline: ${report.pipelineId} v${report.templateVersion} runId: ${report.runId}\n`);
    if (report.resumedFrom) stdout.write(`resumedFrom: ${report.resumedFrom}\n`);
    stdout.write(`executionStatus: ${report.executionStatus}\nfinalStatus: ${report.finalStatus}\ndecision: ${report.decision?.kind ?? 'none'}\n`);
    stdout.write(`stages: ${Object.entries(report.stages).map(([id, s]) => `${id}=${s.status}`).join(' ')}\n`);
    if (report.artifacts.length) stdout.write(`artifacts: ${report.artifacts.length}\n`);
    if (report.changedFiles.length) stdout.write(`changedFiles: ${report.changedFiles.join(',')}\n`);
    try {
      const { persistTrajectory } = await import('../core/trajectory.mjs');
      persistTrajectory(store, report);
    } catch (_) { /* trajectory recording is best-effort */ }
    if (report.finalStatus === 'COMPLETED') return 0;
    if (report.finalStatus === 'QUARANTINED') return 3;
    return 1;
  } catch (err) {
    stderr.write(`pipeline run failed: ${err.message}\n`);
    return 1;
  }
}

async function runKnowledgeIngest(rest, stdout, stderr, cwd) {
  const dirIdx = rest.indexOf('--dir');
  const scopeIdx = rest.indexOf('--scope');
  if (dirIdx < 0 || scopeIdx < 0) {
    stderr.write('workbench knowledge ingest requires --dir <path> --scope <scope>\n');
    return 2;
  }
  try {
    const { StateStore } = await import('../core/store.mjs');
    const { createKnowledgeStore } = await import('../core/knowledge-store.mjs');
    const store = StateStore.open('default', { root: path.join(cwd, '.workbench', 'store') });
    const k = createKnowledgeStore({ store, objectsRoot: path.join(cwd, '.workbench', 'knowledge', 'objects') });
    const kindIdx = rest.indexOf('--kind');
    const kinds = kindIdx >= 0 ? [rest[kindIdx + 1]] : null;
    const out = k.ingestDirectory({ dir: rest[dirIdx + 1], scope: rest[scopeIdx + 1], kinds });
    stdout.write(`ingested: ${out.ingested.length}, skipped: ${out.skipped.length}\n`);
    for (const r of out.ingested.slice(0, 20)) stdout.write(`  ${r.sourcePath} (${r.kind})\n`);
    if (out.ingested.length > 20) stdout.write(`  … ${out.ingested.length - 20} more\n`);
    return 0;
  } catch (err) {
    stderr.write(`knowledge ingest failed: ${err.message}\n`);
    return 1;
  }
}

async function runKnowledgeRetrieve(rest, stdout, stderr, cwd) {
  const qIdx = rest.indexOf('--query');
  const scopeIdx = rest.indexOf('--scope');
  if (qIdx < 0 || scopeIdx < 0) {
    stderr.write('workbench knowledge retrieve requires --query <text> --scope <scope>\n');
    return 2;
  }
  let budget = 8000;
  const bIdx = rest.indexOf('--budget');
  if (bIdx >= 0) {
    const v = Number.parseInt(rest[bIdx + 1], 10);
    if (Number.isNaN(v) || v < 0) {
      stderr.write('workbench knowledge retrieve --budget must be a non-negative integer\n');
      return 2;
    }
    budget = v;
  }
  try {
    const { StateStore } = await import('../core/store.mjs');
    const { createKnowledgeStore } = await import('../core/knowledge-store.mjs');
    const { retrieve } = await import('../core/knowledge-retrieval.mjs');
    const store = StateStore.open('default', { root: path.join(cwd, '.workbench', 'store') });
    const k = createKnowledgeStore({ store, objectsRoot: path.join(cwd, '.workbench', 'knowledge', 'objects') });
    const rows = k.list();
    if (rows.length === 0) {
      stderr.write('knowledge store is empty; run `workbench knowledge ingest` first\n');
      return 1;
    }
    const index = rows.map((r) => ({ ...r, content: k.content(r) }));
    const result = retrieve({ index, query: rest[qIdx + 1], scope: rest[scopeIdx + 1], budgetChars: budget });
    stdout.write(`query: ${result.query}\nscope: ${result.scope}\nitems: ${result.items.length} budgetUsed: ${result.budgetUsed} scopeCapped: ${result.scopeCapped}\n`);
    for (const item of result.items) {
      stdout.write(`  ${item.sourcePath} (score ${item.score}, ${item.scope})\n    matched: ${item.matchedTerms.join(',')}\n`);
    }
    return result.items.length > 0 ? 0 : 1;
  } catch (err) {
    stderr.write(`knowledge retrieve failed: ${err.message}\n`);
    return 1;
  }
}

async function runKnowledgeBenchmark(rest, stdout, stderr, cwd) {
  try {
    const pathMod = await import('node:path');
    const { runRetrievalBenchmark, loadBenchmarkFixture } = await import('../core/retrieval-benchmark.mjs');
    const fIdx = rest.indexOf('--fixture');
    const qIdx = rest.indexOf('--queries');
    const docsDir = fIdx >= 0 && rest[fIdx + 1] ? pathMod.resolve(rest[fIdx + 1]) : pathMod.resolve(cwd, 'fixtures', 'knowledge', 'benchmark', 'documents');
    const queriesPath = qIdx >= 0 && rest[qIdx + 1] ? pathMod.resolve(rest[qIdx + 1]) : pathMod.resolve(cwd, 'fixtures', 'knowledge', 'benchmark', 'queries.json');
    const ctx = loadBenchmarkFixture({ documentsDir: docsDir, queriesPath });
    try {
      const result = runRetrievalBenchmark({ index: ctx.index, benchmark: ctx.benchmark });
      stdout.write(`precisionAt5: ${result.precisionAt5}\nsourceCoverage: ${result.sourceCoverage}\n`);
      for (const q of result.perQuery) {
        stdout.write(`  ${q.id}: precision@5 ${q.precisionAt5} hits=${q.hits.join(',') || '-'}\n`);
      }
      return 0;
    } finally {
      ctx.cleanup();
    }
  } catch (err) {
    stderr.write(`knowledge benchmark failed: ${err.message}\n`);
    return 1;
  }
}

async function runMemoryList(rest, stdout, stderr, cwd) {
  const scopeIdx = rest.indexOf('--scope');
  const scope = scopeIdx >= 0 ? rest[scopeIdx + 1] : null;
  try {
    const { StateStore } = await import('../core/store.mjs');
    const { createProjectMemory } = await import('../core/project-memory.mjs');
    const store = StateStore.open('default', { root: path.join(cwd, '.workbench', 'store') });
    const mem = createProjectMemory({ store, objectsRoot: path.join(cwd, '.workbench', 'memory', 'objects') });
    const rows = mem.query({ scope });
    if (rows.length === 0) {
      stdout.write('no project memory entries\n');
      return 1;
    }
    for (const row of rows) {
      stdout.write(`${row.type}:${row.source} scope=${row.scope ?? '-'} verifier=${row.verifierVersion ?? '-'} evidence=${row.evidenceKind ?? '-'}\n`);
    }
    return 0;
  } catch (err) {
    stderr.write(`memory list failed: ${err.message}\n`);
    return 1;
  }
}

async function runTaskRun(rest, stdout, stderr, cwd, injected = null) {
  const goalIdx = rest.indexOf('--goal');
  if (goalIdx < 0) {
    stderr.write('workbench task run requires --goal <text>\n');
    return 2;
  }
  const goal = rest[goalIdx + 1];
  const approve = rest.includes('--approve-changes');
  const { createTask, createTaskGraph } = await import('../core/task-graph.mjs');
  const { Orchestrator } = await import('../core/orchestrator.mjs');
  const { DevflowRuntimeAdapter } = await import('../adapters/devflow-runtime.mjs');
  const { ProcessAgentInvoker } = await import('../adapters/process-agent.mjs');
  const { AgentRegistry } = await import('../core/agents.mjs');
  const { createChangeSandbox, collectChangeSet } = await import('../core/change-sandbox.mjs');
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    stderr.write('workbench task run requires a Git working copy\n');
    return 2;
  }
  const task = createTask({ id: `cli-${Date.now()}`, goal });
  const graph = createTaskGraph({
    task,
    nodes: [
      { id: 'plan', goal: 'plan the task', acceptanceCriteria: [{ id: 'pa', verifierRef: 'diff', required: true }] },
      { id: 'implement', goal: 'implement', dependencies: ['plan'], acceptanceCriteria: [{ id: 'im', verifierRef: 'diff', required: true }] },
    ],
  });  const registry = new AgentRegistry();
  const deps = injected ?? await buildLiveTaskDeps({ cwd, goal, graph, registry, approve, stderr, DevflowRuntimeAdapter, ProcessAgentInvoker, createChangeSandbox, collectChangeSet });
  const orch = new Orchestrator(deps);
  try {
    const report = await orch.runTask(task, { approveChangeSet: approve ? (cs) => ({ approved: true, actor: 'cli', reason: 'go', changeSetSha256: cs.patchSha256 }) : () => ({ approved: false }) });
    stdout.write(`finalStatus: ${report.finalStatus}\ndecision: ${report.decision.kind}\nexecutionStatus: ${report.executionStatus}\n`);
    if (report.finalStatus === 'COMPLETED') return 0;
    if (report.finalStatus === 'QUARANTINED') return 3;
    return 1;
  } catch (err) {
    stderr.write(`task run failed: ${err.message}\n`);
    return 1;
  }
}

// Resolve the Python interpreter that hosts devflow_runtime. Priority:
// 1. $DFR_PYTHON (absolute path to python.exe)
// 2. `py -3.11` launcher probe
// 3. `python` on PATH
function resolvePython() {
  if (process.env.DFR_PYTHON) return process.env.DFR_PYTHON;
  for (const candidate of [
    ['py', ['-3.11', '-c', 'import sys; print(sys.executable)']],
    ['python', ['-c', 'import sys; print(sys.executable)']],
  ]) {
    try {
      const res = spawnSync(candidate[0], candidate[1], { encoding: 'utf8', windowsHide: true });
      if (res.status === 0 && res.stdout.trim()) {
        const exe = res.stdout.trim();
        if (fs.existsSync(exe)) return exe;
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

function liveRuntimeRunnerFactory(python) {
  return async (argv) => {
    // argv: ['devflow-runtime', '--workspace', ws, <command>, ...]
    const rest = argv.slice(1); // drop the placeholder executable name
    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      const proc = spawn(python, ['-m', 'devflow_runtime.protocol.cli', ...rest], { shell: false, windowsHide: true });
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      const MAX_BYTES = 16 * 1024 * 1024;
      proc.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_BYTES) {
          proc.kill();
          resolve({ stdout: '', stderr: 'runtime stdout exceeded 16MiB', exitCode: 1 });
          return;
        }
        stdout += chunk.toString('utf8');
      });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      proc.on('error', reject);
      proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
    });
  };
}

async function buildLiveTaskDeps({ cwd, graph, registry, approve, stderr, DevflowRuntimeAdapter, ProcessAgentInvoker, createChangeSandbox, collectChangeSet }) {
  const python = resolvePython();
  if (!python) {
    stderr.write('workbench task run: could not locate a Python interpreter with devflow_runtime. Set DFR_PYTHON to the absolute path of python.exe.\n');
    throw new Error('python interpreter not found');
  }
  // Apply manifest-declared agents (which may carry invocation) onto the
  // built-in registry so `task run` can actually drive a process.
  const manifestPath = path.join(cwd, 'workspace.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (Array.isArray(manifest.agents)) {
        registry.applyManifest(manifest.agents);
      }
    } catch (err) {
      stderr.write(`workbench task run: could not read ${manifestPath}: ${err.message}\n`);
    }
  }
  const runtime = new DevflowRuntimeAdapter({ runner: liveRuntimeRunnerFactory(python) });
  // Trust boundary: Runtime is DISABLED by default. Refuse before any Action.
  let runtimeStatus;
  try {
    runtimeStatus = await runtime.status({ workspace: cwd });
  } catch (err) {
    stderr.write(`workbench task run: cannot reach devflow-runtime: ${err.message}\n`);
    throw err;
  }
  if (runtimeStatus.enabled !== true) {
    stderr.write('workbench task run: DevFlow Runtime is disabled for this workspace. Set `enabled: true` in config/runtime.yaml before running a governed task.\n');
    throw new Error('devflow runtime disabled');
  }
  const agents = registry.list();
  const invokable = agents.filter((a) => a.invocation && typeof a.invocation.executable === 'string');
  if (invokable.length === 0) {
    stderr.write('workbench task run: no Agent has an `invocation` configured (executable + args). Declare agents with invocation in workspace.json, or pass injected deps for testing.\n');
    throw new Error('no invokable agent');
  }
  return {
    repoRoot: cwd,
    planner: { plan: async () => graph },
    invoker: new ProcessAgentInvoker(),
    changeSandbox: { create: createChangeSandbox, collect: collectChangeSet },
    runtime,
    agents: { list: () => invokable },
    audit: { agentSelected: () => {}, toolCalled: () => {}, runtimeDecided: () => {} },
  };
}

export async function run(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), options = null) {
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
    if (command === 'task' && subcommand === 'validate') return await runTaskValidate(rest, stdout, stderr, cwd);
    if (command === 'task' && subcommand === 'simulate') return await runTaskSimulate(rest, stdout, stderr, cwd);
    if (command === 'task' && subcommand === 'run') return await runTaskRun(rest, stdout, stderr, cwd, options?.deps);
    if (command === 'task' && subcommand === 'help') return printTaskHelp(stdout) || 0;
    if (command === 'pipeline' && subcommand === 'list') return await runPipelineList(rest, stdout, stderr);
    if (command === 'pipeline' && subcommand === 'simulate') return await runPipelineSimulate(rest, stdout, stderr);
    if (command === 'pipeline' && subcommand === 'status') return await runPipelineStatus(rest, stdout, stderr, cwd);
    if (command === 'pipeline' && subcommand === 'run') return await runPipelineRun(rest, stdout, stderr, cwd, options?.pipeline);
    if (command === 'knowledge' && subcommand === 'ingest') return await runKnowledgeIngest(rest, stdout, stderr, cwd);
    if (command === 'knowledge' && subcommand === 'retrieve') return await runKnowledgeRetrieve(rest, stdout, stderr, cwd);
    if (command === 'knowledge' && subcommand === 'benchmark') return await runKnowledgeBenchmark(rest, stdout, stderr, cwd);
    if (command === 'memory' && subcommand === 'list') return await runMemoryList(rest, stdout, stderr, cwd);
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