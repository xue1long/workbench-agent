# Workspace Runtime Level 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to execute this plan task-by-task. Every task ends with a runnable verification.

**Goal:** Evolve the current M1 preview-only CLI into a local-first, declarative Workspace Runtime that can safely detect, plan, apply, verify, and restore a workspace.

**Architecture:** Keep the current Node.js CLI as the executable boundary and split only when a second responsibility is real. Core owns manifest, state, diff, plan, and lifecycle orchestration; adapters own OS/tool behavior. Persist portable declarations in YAML/lockfile and machine observations/executions in SQLite when persistence is first needed.

**Tech Stack:** Current Node.js built-ins; add SQLite and schema validation only when M2 requires them and the runtime environment supports them. Do not introduce React/Tauri until the CLI lifecycle is proven.

**Spec:** `C:\Users\HP\OneDrive\007 - 个人笔记\000 Inbox\2026-08-23 Agent Workbench — Level 1：Workspace Runtime 开发实施规格.md`

## Global Constraints

- `Local First + Git Driven + Declarative Configuration + Adapter Architecture`.
- Every mutation follows `Detect → Plan → Permission Check → Apply → Verify`.
- Invalid manifests never enter Apply.
- Secrets are references only; real values never enter YAML, Git, or logs.
- Apply stops dependent steps after failure; retry, skip, and rollback are explicit.
- Repeated apply/restore is idempotent and produces `NO CHANGES` when already converged.
- No LLM orchestration, marketplace, knowledge graph, cloud sync, or team permissions in Level 1.
- Runtime governance target: `Intent → Action → Evidence → State → Decision`; do not claim governed execution while `dfr` is unavailable.

## Current Baseline

- `workbench.mjs`: M1 manifest-to-plan CLI with a deliberately narrow YAML reader.
- `fixtures/example-workspace.yaml`: M1 sample manifest.
- `tests/m1_plan.test.mjs`: two Node test-runner checks.
- Current verification: `node --test tests/m1_plan.test.mjs` passes; CLI preview produces the expected three steps.
- Governance blocker: `dfr` is not on PATH in `D:\5-Project\20260819\devflow-runtime`; install/runtime setup is required before governed source edits there.

## Phase Gates

| Gate | Exit condition | Do not start next phase until |
|---|---|---|
| M1 | Manifest → State → Diff → Plan | invalid manifest and no-op plan tests pass |
| M2 | Plan → Apply → Verify | second apply makes no destructive change |
| M3 | Agent/Skill/MCP configuration | secret values absent from artifacts and logs |
| M4 | Sync → Restore on a clean directory | second restore reports no changes |
| M5 | UI calls the same CLI/Core API | UI contains no adapter logic |

### Current State — M4 complete

- 182 tests pass (`node --test tests/*.test.mjs`)
- E2E acceptance (`tests/e2e_machine_a_to_b.test.mjs`): Machine A `workbench sync --apply` → git commit → Machine B `git clone` → `workbench restore` → `NO CHANGES` → second restore → `NO CHANGES`
- Drift recovery: lockfile refresh on second restore when manifest versions diverge from lockfile
- Audit redaction: secret values never reach the JSONL store or the CLI
- State persistence: `StateStore` (JSONL) at `.workbench/store/<workspaceId>/<table>.jsonl`; SQLite swap-in ready behind the same interface
- Snapshot/Rollback: `core/snapshot.mjs` + `core/rollback.mjs`; `workbench rollback --to <snapId>`
- Deliberate omissions kept: `node_modules/` zero runtime deps; better-sqlite3 deferred (no VS / no Node 24 prebuilt on win32-x64)

---

### Task 1: Harden M1 manifest handling

**Files:**
- Modify: `workbench.mjs`
- Modify: `fixtures/example-workspace.yaml`
- Modify: `tests/m1_plan.test.mjs`
- Create: `schemas/workspace.schema.json`

**Interfaces:**
- `loadManifest(path) -> Manifest`.
- `validateManifest(manifest) -> void | throws ManifestError`.
- `planFromManifest(manifest, observed) -> ExecutionPlan`.

- [ ] Replace regex parsing with a real YAML/schema boundary; keep only the fields used by M1.
- [ ] Validate `version`, `workspace.id`, and `environment.*.version`; reject unknown top-level values only if the chosen schema validator supports it cleanly.
- [ ] Add tests for malformed YAML, missing workspace id, missing environment version, matching versions, upgrades, and missing tools.
- [ ] Verify with `node --test tests/m1_plan.test.mjs` and a fixture CLI preview.

### Task 2: Add explicit Core state and adapter contracts

**Files:**
- Create: `core/state.mjs`
- Create: `core/adapters.mjs`
- Modify: `workbench.mjs`
- Create: `tests/state_and_adapter.test.mjs`

**Interfaces:**
- `ObservedState { resources: Map<string, ResourceState> }`.
- `Adapter.detect() -> ResourceState`.
- `Adapter.verify(desired) -> VerificationResult`.
- `Adapter.apply(action) -> ApplyResult`.

- [ ] Move resource comparison out of CLI code into Core.
- [ ] Define one adapter contract and one result shape: `{ success, changed, status, message, details }`.
- [ ] Keep adapters pure at first: fake environment adapter in tests; no installation yet.
- [ ] Verify ordering and no-op behavior with a small Node test.

### Task 3: Implement M2 environment adapters and Apply

**Files:**
- Create: `adapters/node.mjs`
- Create: `adapters/python.mjs`
- Create: `adapters/uv.mjs`
- Create: `core/apply.mjs`
- Modify: `workbench.mjs`
- Create: `tests/apply.test.mjs`

**Interfaces:**
- `createEnvironmentAdapters() -> Map<string, Adapter>`.
- `applyPlan(plan, adapters, options) -> ApplyReport`.

- [ ] Detect versions through executable commands only after validating executable names and argument arrays.
- [ ] Apply only explicit `INSTALL`/`UPDATE` steps; M2 must not delete, force-push, or reset repositories.
- [ ] Stop on failure and mark dependent steps unexecuted.
- [ ] Add dry-run/preview as the default and require `--apply` for mutation.
- [ ] Add tests using injected fake adapters; no real system installation in tests.
- [ ] Verify `plan`, `apply --dry-run`, and a controlled fake apply.

### Task 4: Add SQLite machine state and audit records

**Files:**
- Create: `core/store.mjs`
- Create: `core/audit.mjs`
- Modify: `core/apply.mjs`
- Create: `tests/store_audit.test.mjs`

**Interfaces:**
- `StateStore.saveObservation(workspaceId, resourceState)`.
- `StateStore.recordExecution(execution)`.
- `AuditLog.record(event)`.

- [ ] Store workspace, resource, execution, verification, and audit records; keep manifest/lockfile portable.
- [ ] Redact fields named `token`, `secret`, `password`, `key`, or configured secret references before persistence/logging.
- [ ] Verify records survive a fresh process and redaction is tested.

### Task 5: Add project management through Git adapter

**Files:**
- Create: `adapters/git.mjs`
- Create: `core/projects.mjs`
- Modify: `schemas/workspace.schema.json`
- Create: `tests/project_manager.test.mjs`

**Interfaces:**
- `GitAdapter.cloneOrFetch(project) -> ApplyResult`.
- `ProjectManager.sync(projects, root) -> ProjectReport`.

- [ ] Support local path and Git source with clone/fetch/status/verify.
- [ ] Refuse force-push, branch deletion, and `reset --hard`.
- [ ] Use temporary test repositories or fake command runners; never depend on a network repository in tests.

### Task 6: Add agent, skill, MCP, and secret reference models

**Files:**
- Create: `core/agents.mjs`
- Create: `core/packages.mjs`
- Create: `core/mcp.mjs`
- Create: `core/secrets.mjs`
- Create: `schemas/package.schema.json`
- Create: `schemas/agent.schema.json`
- Create: `schemas/mcp.schema.json`
- Create: `tests/config_models.test.mjs`

**Interfaces:**
- `AgentDefinition` with `id`, `provider`, `executable`, `configPaths`, `capabilities`, `status`.
- `PackageDefinition` with `id`, `type`, `version`, `source`, `permissions`.
- `McpDefinition` with `id`, `transport`, `command`, `args`, `environment`.
- `SecretStore.get/set/delete/exists`; manifest stores `{ secret: NAME }` references only.

- [ ] Implement data validation and normalized model first.
- [ ] Implement only read/detect/config translation needed for Claude Code, Codex, Skill, and MCP.
- [ ] Do not implement capability routing or agent selection.
- [ ] Add a test proving secret values never appear in generated config, audit records, or CLI output.

### Task 7: Add lockfile, snapshot, rollback, sync, and restore

**Files:**
- Create: `core/lockfile.mjs`
- Create: `core/snapshot.mjs`
- Create: `core/restore.mjs`
- Modify: `core/store.mjs`
- Create: `tests/restore.test.mjs`

**Interfaces:**
- `writeLockfile(path, appliedState)`.
- `createSnapshot(paths) -> Snapshot`.
- `restoreWorkspace(manifestPath, options) -> RestoreReport`.

- [ ] Write `workspace.lock` only from verified applied state.
- [ ] Snapshot managed config, MCP config, agent config, and lockfile before mutation.
- [ ] Restore using lockfile when present, otherwise manifest; never overwrite unmanaged files.
- [ ] Add the clean-directory restore test and repeat restore until the report is `NO CHANGES`.

### Task 8: Expose stable CLI commands

**Files:**
- Modify: `workbench.mjs`
- Create: `docs/cli.md`
- Create: `tests/cli.test.mjs`

**Commands:**

```text
workbench init
workbench status
workbench plan
workbench apply --dry-run
workbench apply
workbench verify
workbench sync
workbench restore
workbench project list
workbench agent list
workbench mcp list
```

- [ ] Keep CLI as a thin caller of Core functions.
- [ ] Return non-zero exit codes for validation, apply, verification, and rollback failures.
- [ ] Verify help, invalid manifest, preview, apply, verify, and restore flows.

### Task 9: Add UI only after CLI acceptance

**Files:**
- Create: `apps/web/` and `apps/desktop/` only after M4 passes.

- [ ] Create a read-only dashboard first.
- [ ] Wire buttons to the same Core/Application API; do not call Git, shells, or agent config directly from UI.
- [ ] Add accessibility basics and one smoke test.

## Runtime Governance Checkpoints

For every implementation task:

1. **Intent:** record the exact task and allowed files.
2. **Action:** execute through the runtime Action Gateway; do not edit governed runtime source directly.
3. **Evidence:** attach test output, CLI output, and changed-file list.
4. **State:** update the phase gate and persisted audit state.
5. **Decision:** continue, revise, or stop based on evidence.

Before starting implementation, install/activate `devflow-runtime` so `dfr status`, `dfr review`, and the Action Gateway are available. Until then, this document is a plan only.

## Verification Commands

Current M4:

```powershell
node --test tests/*.test.mjs
node src/workbench.mjs plan --manifest fixtures/example-workspace.json
node src/workbench.mjs apply --manifest fixtures/example-workspace.json --apply
node src/workbench.mjs sync --manifest fixtures/example-workspace.json --apply --no-git
node src/workbench.mjs restore --manifest fixtures/example-workspace.json --apply
```

Future phase gate:

```powershell
node src/workbench.mjs rollback --to <snapshotId>
```

## Deliberate Omissions

- No React/Tauri until the CLI lifecycle works.
- No custom package registry; Git sources are sufficient for Level 1.
- No real secret backend until the reference model and redaction tests exist.
- No cloud sync API; Git commands cover the first sync/restore path.
- No full YAML implementation if a maintained parser is unavailable; do not silently ship a regex parser beyond the M1 fixture shape.
