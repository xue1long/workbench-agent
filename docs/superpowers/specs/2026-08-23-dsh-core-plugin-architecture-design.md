# DSH-Core Agent Workbench Architecture Design

**Date:** 2026-08-23

**Status:** Approved direction; implementation plan pending review

**Decision:** Use upstream DeepSeek Harness (`dsh`) as the product host and Agent runtime. Deliver Agent Workbench capabilities as out-of-tree dsh plugins and a Workbench profile. Do not maintain a product fork of dsh.

## 1. Purpose

Agent Workbench should provide a local-first environment in which agents can operate on reproducible workspaces, execute governed development workflows, retrieve scoped knowledge, evaluate results, and propose evidence-backed improvements.

The existing repository has already validated the domain behavior through Level 4:

- Workspace manifest, detection, planning, apply, verification, sync, snapshot, restore, and rollback.
- Deterministic task graphs, routing, retry, review, approval, DevFlow governance, and fail-closed completion.
- Development pipelines, artifact linkage, scoped knowledge retrieval, and reviewed project memory.
- Trajectory projection, evaluation, frozen benchmarks, and dashboard reporting.

This design changes the product host, not those goals. dsh becomes responsible for Agent execution, sessions, tools, model adapters, sandbox integration, plugin lifecycle, and the base WebUI. Workbench plugins retain the differentiated workspace and governance behavior.

## 2. Goals

1. Make dsh the single Agent runtime and application host.
2. Preserve all accepted Level 1-4 Workbench behavior during migration.
3. Add Workbench capabilities through documented dsh Profile, Bundle, Service, Event, Remote, and Client Plugin mechanisms.
4. Keep dsh upgradeable without repeatedly merging a long-lived fork.
5. Preserve the invariant that Agent output is an untrusted claim and only trusted verification can complete a governed task.
6. Replace duplicate Agent, session, tool, sandbox, and Web server implementations after parity is proven.
7. Keep later knowledge, evaluation, evolution, intelligence, and experiment capabilities independently installable where they have independent lifecycle and data ownership.

## 3. Non-goals

- Reimplement dsh Agent Loop, Session Log, model adapters, tool registry, subagents, credentials, storage, or base WebUI.
- Copy the dsh repository into this repository.
- Track the dsh `master` branch in production.
- Allow a dsh session or model response to bypass Workbench approval or trusted verification.
- Migrate every existing module before proving one complete governed vertical slice.
- Create empty future-plugin shells before their migration or product phase starts.
- Maintain two writable sources of truth for the same domain fact.

## 4. Upstream Strategy

The repository remains an independent plugin monorepo. It consumes a published dsh release and locks the exact version in the package manifest and lockfile. Version ranges are not used for production builds.

The dsh source tree is treated as read-only. Workbench behavior is mounted through an out-of-tree Profile and Bundle. A new dsh release is first installed on an upgrade candidate branch and promoted only after compatibility, WebUI, migration, and governed-task tests pass.

One temporary WebUI patch is permitted only when dsh lacks a necessary general extension point. The patch must:

- live in one `patches/` entry;
- add extension plumbing rather than Workbench business behavior;
- apply automatically in CI against the locked dsh version;
- have a linked upstream contribution or documented removal condition;
- block a dsh upgrade if it no longer applies cleanly.

No Host, Agent Loop, Session, Tool, Sandbox, or Storage source patch is allowed.

## 5. Target Architecture

```text
Published dsh release
├── dsh-base
├── dsh-web-app / dsh-headless
├── Agent / Agent Loop / Subagent
├── Session Event Log
├── Tools / MCP / Skills / LLM
├── Workspace Registry
├── Workflow Engine
├── Filesystem / Subprocess / Sandbox
├── Storage / Credentials / Settings
└── Remote and Client extension mechanisms
    │
    └── workbench-profile
        ├── workbench-runtime
        ├── workbench-governed-tasks
        ├── workbench-web
        ├── workbench-knowledge       (migration wave 2)
        ├── workbench-evaluation      (migration wave 2)
        └── later phase plugins
```

The Workbench Profile is the product composition. The default dsh Web and Headless profiles must remain independently startable without Workbench plugins.

## 6. Repository Layout

```text
packages/
├── dsh-compat/
├── plugin-runtime/
├── plugin-governed-tasks/
├── plugin-web/
├── plugin-knowledge/
└── plugin-evaluation/

profiles/
└── workbench/

patches/
└── at most one temporary dsh Web extension patch
```

`dsh-compat` is a library, not a plugin. `profiles/workbench` is a dsh Profile/Bundle, not a business module.

Existing source remains in place while parity work is underway. Files are moved or deleted only after the replacement plugin passes its acceptance gate.

## 7. dsh Compatibility Module

`dsh-compat` is the only Workbench package allowed to import dsh runtime types, event names, Remote declarations, or Client extension interfaces directly. It exposes Workbench-owned types and narrow helper interfaces to business plugins.

Responsibilities:

- Re-export the minimal stable dsh Service and plugin primitives required by Workbench plugins.
- Normalize dsh Workspace, Agent, Session, Workflow, Sandbox, Storage, and Remote values into Workbench-owned records.
- Contain version-specific event and Client registration details.
- Expose runtime compatibility checks used during boot and upgrade tests.
- Reject unsupported dsh versions with a clear diagnostic before Workbench plugins activate.

Business plugins may depend on `dsh-compat`, but must not import private dsh paths. If a dsh upgrade requires edits in multiple business plugins, the compatibility seam is considered breached and must be repaired before promotion.

## 8. Initial Business Plugins

### 8.1 `workbench-runtime`

This plugin extends dsh workspaces with reproducible environment management. It uses the dsh workspace identity and `ctx.workspaceRegistry`; it does not create a second workspace identity system.

Responsibilities:

- Load and validate the Workbench manifest associated with a dsh workspace.
- Detect observed Node, Python, uv, Git, project, Agent, MCP, and package state.
- Produce deterministic plans and apply explicitly authorized changes.
- Verify the resulting state.
- Synchronize projects and generated Agent configuration.
- Own Workbench lockfiles, snapshots, restore, and rollback.
- Store secret references while delegating secret values to dsh Credentials.

Its external interface is a deep `ctx.workspaceRuntime` module. Callers request status, plan, apply, sync, restore, or rollback without learning adapter selection, lockfile format, snapshot layout, or credential implementation.

### 8.2 `workbench-governed-tasks`

This plugin owns deterministic, evidence-governed work. It does not replace the dsh Workflow Engine for ordinary model-authored workflows.

Responsibilities:

- Validate Task and TaskGraph definitions.
- Run fixed development pipelines and bounded DAG execution.
- Route nodes to dsh Agents or Subagents.
- Apply concurrency, retry, fallback, review, replan, budget, and deadline rules.
- Use dsh Filesystem, Subprocess, and Sandbox capabilities for candidate work.
- Collect bounded candidate changes.
- Record explicit human approval.
- Submit approved changes to DevFlow Runtime.
- Persist Evidence Claims, trusted Evidence references, integrity state, and Decision.
- Resume only from previously verified stages.

Its external interface is a deep `ctx.governedTasks` module. The interface exposes task submission, inspection, approval, cancellation, and resume. Agent invocation, sandbox lifecycle, routing, and DevFlow protocol details remain internal.

The completion rule is immutable:

```text
dsh execution success
  != Workbench completion

Workbench completion
  = approved candidate
  + valid DevFlow EventStore integrity
  + all required trusted verifier Evidence
  + Decision.kind == "finish"
```

### 8.3 `workbench-web`

This plugin adds the Workbench product experience to dsh WebUI.

Responsibilities:

- Workspace status, plan, sync, restore, and rollback views.
- Task creation, DAG and pipeline progress, routing, cost, and failure views.
- Candidate diff review and approval.
- Evidence, Decision, audit, knowledge, trajectory, and evaluation views.
- Workbench navigation, branding, and settings contributions.

The Client side communicates only through typed Remote interfaces supplied by the Host plugins. It does not read plugin storage or import business implementations. Live updates are derived from durable domain records and dsh Session Events.

## 9. Migration-Wave Plugins

### 9.1 `workbench-knowledge`

Migrates the accepted Level 3 knowledge behavior:

- Repository and Markdown ingestion.
- Content-addressed artifact storage.
- Deterministic path and keyword retrieval.
- Scope and context-budget enforcement.
- Source citations.
- Reviewed project decisions and verified artifact memory.

It consumes dsh workspace identity and storage. It never stores unreviewed Agent claims as durable project memory.

### 9.2 `workbench-evaluation`

Migrates the accepted Level 4 trajectory and evaluation behavior:

- Versioned trajectory projections.
- Rule, test, static-analysis, human-feedback, and optional LLM-judge evaluators.
- Separate raw evidence and derived scores.
- Frozen benchmark suites and redacted exchange.
- Cost, latency, success, failure, workflow, Agent, and evaluator-version reporting.

LLM-judge output remains separate and cannot override failed tests or security checks.

## 10. Later-Phase Plugin Policy

Later capabilities become plugins only when they reach implementation:

- `workbench-evolution`: candidate ranking, offline benchmark, approval, canary, and rollback.
- `workbench-intelligence`: external evidence ingestion, provenance, and candidate patterns.
- `workbench-lab`: evidence graph and controlled experiments, created only when Level 7 begins and only if it has a lifecycle independent from intelligence ingestion.

Router, retry, approval, DevFlow protocol, snapshot, lockfile, and individual evaluators remain internal modules. They are not independently installable products and must not become standalone plugins.

## 11. Native dsh Reuse

| Capability | Owner after migration | Workbench action |
| --- | --- | --- |
| Agent Loop and live Agent registry | dsh | Delete duplicate implementation after parity |
| Model adapters and streaming | dsh | Reuse |
| Session Event Log | dsh | Reuse for model-visible and conversational facts |
| Tool, MCP, and Skill registries | dsh | Reuse; add Workbench tools as consumers |
| Workspace identity and session membership | dsh | Extend through `workbench-runtime` |
| Model-authored dynamic workflows | dsh | Reuse `ctx.workflowEngine` |
| Deterministic governed DAG | Workbench | Retain in `workbench-governed-tasks` |
| Filesystem, subprocess, and sandbox capabilities | dsh | Reuse providers and policies |
| Workspace manifest, plan, sync, restore | Workbench | Retain in `workbench-runtime` |
| Trusted mutation and completion | DevFlow via Workbench | Retain fail-closed behavior |
| Base WebUI and session UI | dsh | Extend through `workbench-web` |
| Knowledge and evaluation domain behavior | Workbench | Migrate to dedicated plugins |

## 12. Data Ownership

Each fact has one writable owner:

| Data | Writable owner |
| --- | --- |
| User/model/tool/session events | dsh Session Log |
| Workspace identity and session membership | dsh Workspace Registry |
| Manifest, lockfile, snapshot metadata, observed/applied state | `workbench-runtime` |
| Task, node, routing, approval, candidate, Evidence references, Decision | `workbench-governed-tasks` |
| Canonical governed Intent, Action, Evidence, State, Decision | DevFlow EventStore |
| Knowledge metadata and reviewed memory | `workbench-knowledge` |
| Trajectory, evaluator configuration, raw evidence, derived scores | `workbench-evaluation` |

Large artifact content is stored as content-addressed files. Plugin storage contains hashes, locations, scopes, versions, and provenance rather than duplicate large content.

Migration may read legacy `.workbench` data and dsh data concurrently, but writes go to only one owner. No dual-write migration is permitted.

## 13. Governed Task Flow

```text
1. WebUI or tool submits a task to ctx.governedTasks.
2. The plugin validates or constructs the deterministic TaskGraph.
3. Ready nodes are routed to dsh Agents/Subagents.
4. dsh executes each node in an isolated workspace sandbox.
5. Workbench records Agent output as Evidence Claims and collects candidate files.
6. The WebUI presents the exact candidate digest and diff for approval.
7. Without approval, the run remains AWAITING_APPROVAL and no canonical mutation occurs.
8. After approval, the DevFlow adapter submits the version-bound Action.
9. DevFlow applies through its Action Gateway and emits trusted verifier Evidence.
10. Workbench maps a valid finish Decision to COMPLETED and projects the result into dsh-visible status.
```

A cancellation, deadline breach, invalid candidate, approval mismatch, failed verifier, corrupt EventStore, or uncertain recovery prevents completion. Corrupt or uncertain governed state becomes quarantined rather than guessed or silently repaired.

## 14. WebUI Extension Design

The WebUI is extended in this order:

1. Client Plugin and documented registration interfaces.
2. Typed Remote methods for Host data and commands.
3. Conversation Node renderers for task, approval, Evidence, and Decision events.
4. Settings Cards for Workbench configuration.
5. General navigation or page extension contributed upstream to dsh.
6. The single temporary extension patch allowed by Section 4.

Workbench business behavior never lives in the patch. The patch may only make a generic extension contribution possible.

The first WebUI release contains functional workspace, task, approval, and Evidence views. Knowledge and evaluation views are added when their plugins migrate. Visual redesign follows functional parity and upgrade compatibility.

## 15. Failure Isolation

- Unsupported dsh version: Workbench Profile refuses activation with the supported range and detected version; default dsh profiles remain usable.
- Optional plugin unavailable: dependent Workbench navigation and tools are hidden or marked unavailable; unrelated dsh capabilities continue.
- Required core plugin unavailable: governed mutations are disabled; read-only status remains available when safe.
- DevFlow unavailable: candidates may be preserved, but approval cannot cause mutation and completion cannot be reported.
- Storage migration failure: legacy data remains untouched; the new plugin refuses write activation.
- Web Client incompatibility: Host plugins remain usable through Headless/commands; the candidate dsh upgrade is rejected.
- Temporary patch conflict: dependency installation or CI fails before packaging.

## 16. Migration Route

### Phase 0: Compatibility spike

Prove an out-of-tree Profile, Host Plugin, Client Plugin, Remote call, Conversation Node, Settings Card, Workspace access, Agent/Subagent execution, Sandbox use, and one dsh version upgrade. Select and lock the exact dsh release only after this gate passes.

### Phase 1: Plugin skeleton

Create `dsh-compat`, the Workbench Profile, and the three initial plugins. Boot dsh Web and Headless with and without the Workbench Profile.

### Phase 2: Governed vertical slice

Deliver one path: open workspace, submit one-node task, edit one UTF-8 file in a dsh sandbox, review the diff, approve the digest, apply through DevFlow, verify, and display Evidence and Decision.

No bulk migration starts before this slice passes.

### Phase 3: Workspace Runtime parity

Migrate manifest, detect, plan, apply, verify, project sync, lockfile, snapshot, restore, rollback, configuration, and secret-reference behavior into `workbench-runtime`. Compare new read results with the existing implementation; never dual-write mutations.

### Phase 4: Governed task parity

Migrate deterministic DAGs, pipelines, routing, concurrency, retry, fallback, review, replan, resume, approval, DevFlow, Evidence, and audit behavior. Replace process-based generic Agent and Planner invocation with dsh Agent/Subagent execution.

### Phase 5: Web product parity

Deliver workspace, task, approval, Evidence, and audit pages. Preserve dsh session functionality and validate both Web and Headless operation.

### Phase 6: Knowledge and evaluation migration

Move accepted Level 3 and Level 4 behavior into their plugins. Add their Web contributions only after Host contract tests pass.

### Phase 7: Cutover and cleanup

Provide a one-way, idempotent legacy-data import with dry-run reporting. Switch the default product entry to the Workbench Profile. Retain legacy data read-only and retain the previous release artifact for rollback. Delete duplicate implementations only after equivalent acceptance tests pass.

### Phase 8: Continuous dsh upgrade lane

For every candidate dsh release: install, type-check, run compatibility contracts, run plugin tests, boot Web and Headless, run the governed vertical slice, run legacy-data compatibility tests, and require explicit promotion.

### Phase 9: Resume product roadmap

Implement or migrate evolution, intelligence, evidence graph, experiment, and package goals as independently accepted phases. They may not weaken the trusted completion rule established by `workbench-governed-tasks`.

### Planning decomposition

This architecture is intentionally larger than one implementation plan. Execution must be decomposed into the following independently reviewed plans:

1. dsh compatibility spike and locked-version selection.
2. Workbench Profile, compatibility library, and plugin skeleton.
3. Governed vertical slice.
4. Workspace Runtime parity migration.
5. Governed task parity migration.
6. Workbench WebUI parity migration.
7. Knowledge and evaluation plugin migration.
8. Legacy import, cutover, cleanup, and continuous upgrade lane.

Each plan must deliver working, testable software and satisfy its own exit gate before the next plan begins. Later product-roadmap plugins receive separate designs and plans when their phase starts.

## 17. Testing Strategy

Tests cross the same interfaces used by callers.

1. `dsh-compat` contract tests against the exact locked dsh version.
2. Plugin interface tests with dsh-provided test support where available.
3. Existing Workbench behavioral tests ported by domain, preserving accepted invariants rather than old file layout.
4. Web Host/Client contract and browser smoke tests.
5. Governed vertical-slice E2E with a real temporary Git repository and real DevFlow stable protocol.
6. Legacy import dry-run, idempotency, interrupted import, and rollback tests.
7. Upgrade tests against the current locked version and one candidate released version.

The migration gate starts from the accepted Level 4 baseline of 414 Workbench tests. A module is removed only after its replacement tests pass twice from clean checkouts and its phase acceptance document records the evidence.

## 18. Release and Rollback

Every Workbench release records:

- exact dsh version;
- Workbench Profile and plugin versions;
- compatibility module version;
- storage schema versions;
- temporary patch identity, if present;
- acceptance evidence and rollback target.

Rollback restores the previous Workbench release and lockfile. Legacy data is never deleted automatically. Schema migrations are append-only or create a new versioned store so rollback never requires reverse-mutating accepted historical data.

## 19. Acceptance Criteria

The architecture migration is complete when:

- Workbench starts as an out-of-tree dsh Profile without a dsh product fork.
- Default dsh Web and Headless profiles still start without Workbench plugins.
- The governed vertical slice completes through dsh Agent execution and DevFlow trusted verification.
- No path reports completion from dsh execution success alone.
- Workspace Runtime behavior is equivalent to the accepted existing behavior.
- Level 2-4 orchestration, pipeline, knowledge, and evaluation invariants remain covered.
- Workbench WebUI uses plugin and Remote extension mechanisms; any remaining patch satisfies Section 4.
- A candidate dsh version can be evaluated without merging upstream source into this repository.
- The repository contains only one Agent Loop, Session system, generic Tool Registry, and base Web server: those supplied by dsh.
- Legacy data can be imported idempotently and remains recoverable.

## 20. Deliberate Deferrals

- Automatic unattended promotion of dsh updates.
- A hosted Workbench plugin marketplace.
- A second database, queue, vector store, or graph database without measured need.
- Splitting routing, approval, retry, snapshot, lockfile, or DevFlow protocol into standalone plugins.
- Full visual redesign before functional and upgrade parity.
- Level 6-7 plugin layout beyond the minimum named in Section 10.

## 21. Primary References

- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness Packages](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages)
- [DeepSeek Harness Workspace family](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/workspace)
- [DeepSeek Harness Workflow family](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/workflow)
- Existing Workbench Level 2-7 execution plan: `docs/superpowers/plans/2026-08-23-agent-workbench-level-2-to-7-execution.md`
- Existing acceptance records: `docs/level-2-acceptance.md`, `docs/level-3-acceptance.md`, `docs/level-4-acceptance.md`
