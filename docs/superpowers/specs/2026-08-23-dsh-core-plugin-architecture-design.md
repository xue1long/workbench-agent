# DSH-Core Agent Workbench Architecture Design

**Date:** 2026-08-23

**Status:** Revised after architecture audit; pending final user review

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
8. Prevent every pre-approval Agent capability from writing to the canonical workspace.
9. Keep complete dsh session history encrypted and lifecycle-managed while retaining digest-only governance projections.
10. Support one exact dsh version at a time through a repeatable candidate-upgrade lane.

## 3. Non-goals

- Reimplement dsh Agent Loop, Session Log, model adapters, tool registry, subagents, credentials, storage, or base WebUI.
- Copy the dsh repository into this repository.
- Track the dsh `master` branch in production.
- Allow a dsh session or model response to bypass Workbench approval or trusted verification.
- Migrate every existing module before proving one complete governed vertical slice.
- Create empty future-plugin shells before their migration or product phase starts.
- Maintain two writable sources of truth for the same domain fact.
- Support several dsh versions simultaneously.
- Continue running an older Workbench binary after a migrated workspace has accepted its first new-system write.
- Expose mutating Workbench WebUI operations over an unauthenticated non-loopback listener.

## 4. Upstream Strategy

The repository remains an independent pnpm plugin monorepo running on Node.js 24 LTS. It consumes a published dsh release and locks one exact version in the package manifest and lockfile. Version ranges and multi-version compatibility are not used for production builds.

The dsh source tree is treated as read-only. Workbench behavior is mounted through an out-of-tree Profile and Bundle. Discovery of a new release creates an upgrade candidate; ordinary releases must be evaluated within 30 days and security releases within 72 hours. Promotion occurs only after compatibility, WebUI, migration, and governed-task tests pass. A failed candidate does not force support for that version: Workbench remains on the current locked version and may evaluate a later release directly.

One temporary WebUI patch is permitted only when dsh lacks a necessary general extension point. The patch must:

- live in one `patches/` entry;
- add extension plumbing rather than Workbench business behavior;
- apply automatically in CI against the locked dsh version;
- have a linked upstream contribution or documented removal condition;
- block a dsh upgrade if it no longer applies cleanly.

No Host, Agent Loop, Session, Tool, Sandbox, or Storage source patch is allowed.

For a critical upstream vulnerability, Workbench first disables the affected capability. If disabling it cannot make the product safe, a temporary security build may pin an exact reviewed upstream commit. That build requires a linked upstream Issue or pull request, the complete release gate, and review every seven days. It must never become a permanent fork.

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
        ├── workbench-web-shell
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
├── plugin-web-shell/
├── plugin-knowledge/
└── plugin-evaluation/

profiles/
└── workbench/

patches/
└── at most one temporary dsh Web extension patch
```

Each domain plugin may provide Host and Client entries that ship together. `dsh-compat` is a library, not a plugin. `profiles/workbench` is a dsh Profile/Bundle, not a business module.

Existing source remains in place while parity work is underway. Files are moved or deleted only after the replacement plugin passes its acceptance gate.

## 7. dsh Compatibility Module

`dsh-compat` is a narrow adapter for dsh interfaces that are undocumented, version-sensitive, or proven unstable during the compatibility spike. Business plugins may import documented public `@deepseek-ai/dsh-*` packages directly, but may not import private source paths.

Responsibilities:

- Normalize only version-sensitive Workspace, Agent, Session, Workflow, Sandbox, Storage, Remote, and Client extension details that cannot be expressed through a documented public package.
- Contain version-specific event and Web contribution registration details.
- Expose runtime compatibility checks used during boot and upgrade tests.
- Reject unsupported dsh versions with a clear diagnostic before Workbench plugins activate.

The compatibility library must not mirror the complete dsh public interface or become a pass-through facade. If one unstable dsh change requires edits in multiple business plugins, the compatibility seam is considered breached and must be repaired before promotion.

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
- Register its own Workspace pages and typed Remote contributions with the Web shell.

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
- Persist Evidence Claims plus rebuildable projections of trusted Evidence identifiers, integrity state, and Decision identifiers.
- Resume only from previously verified stages.
- Register its own task, approval, Evidence, and audit pages with the Web shell.

Its external interface is a deep `ctx.governedTasks` module. The interface exposes task submission, inspection, change approval, cancellation, and resume. Agent invocation, sandbox lifecycle, routing, and DevFlow protocol details remain internal.

Every governed run has one detached Git worktree. Model-visible and tool capabilities receive that worktree as their only workspace root: Filesystem, Shell, PTY, LSP, Subprocess, Agent, and Subagent execution must share the same candidate execution world. The canonical workspace is not mounted writable or passed to the Agent. Mutating nodes execute serially; only nodes proven read-only may overlap. Parallel mutating worktrees and merge orchestration are deferred until measured need.

Every governed run owns one supervisor dsh Session. Each node attempt owns one child Session. `workbench-governed-tasks` persists an immutable correlation record:

```text
workbenchRunId
├── supervisorSessionId
├── nodeId
│   └── attempt → childSessionId
├── devflowSessionId
├── candidateDigest
└── changeApprovalId
```

The two approval kinds are intentionally separate:

- `ExecutionApproval` is dsh's one-shot authorization for a tool action inside the candidate worktree.
- `ChangeApproval` is Workbench authorization to submit one exact candidate to DevFlow. It binds Intent identity and version, state revision, candidate digest, actor, issue time, and expiry.

An `ExecutionApproval` can never satisfy a `ChangeApproval`; the identifiers, UI labels, audit records, and error types are distinct.

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

### 8.3 `workbench-web-shell`

This plugin adds the minimum Workbench product shell to dsh WebUI.

Responsibilities:

- Workbench navigation, layout, branding, and global settings.
- Capability discovery for installed Workbench domain plugins.
- Shared loading, unavailable, compatibility, and error states.
- A registration interface through which domain plugins contribute routes, navigation entries, settings, and Conversation Node renderers.

Workspace, task, approval, Evidence, knowledge, trajectory, and evaluation pages remain colocated with their owning domain plugins. Client entries communicate only through typed Remote interfaces supplied by their matching Host plugin. They do not read plugin storage or import Host implementations. Live updates are derived from durable domain records and dsh Session Events.

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
It registers its retrieval, source, and project-memory pages with the Web shell when installed.

### 9.2 `workbench-evaluation`

Migrates the accepted Level 4 trajectory and evaluation behavior:

- Versioned trajectory projections.
- Rule, test, static-analysis, human-feedback, and optional LLM-judge evaluators.
- Separate raw evidence and derived scores.
- Frozen benchmark suites and redacted exchange.
- Cost, latency, success, failure, workflow, Agent, and evaluator-version reporting.

LLM-judge output remains separate and cannot override failed tests or security checks.
The plugin registers trajectory, benchmark, evaluator, and score pages with the Web shell when installed.

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
| Session Event Log | dsh with Workbench persistence policy | Reuse through encrypted Session Persistence |
| Tool, MCP, and Skill registries | dsh | Reuse; add Workbench tools as consumers |
| Workspace identity and session membership | dsh | Extend through `workbench-runtime` |
| Model-authored dynamic workflows | dsh | Reuse `ctx.workflowEngine` |
| Deterministic governed DAG | Workbench | Retain in `workbench-governed-tasks` |
| Filesystem, subprocess, and sandbox capabilities | dsh | Reuse providers and policies |
| Workspace manifest, plan, sync, restore | Workbench | Retain in `workbench-runtime` |
| Trusted mutation and completion | DevFlow via Workbench | Retain fail-closed behavior |
| Base WebUI and session UI | dsh | Extend through the Web shell and domain Client contributions |
| Knowledge and evaluation domain behavior | Workbench | Migrate to dedicated plugins |

## 12. Data Ownership

Each fact has one writable owner:

| Data | Writable owner |
| --- | --- |
| User/model/tool/session events | dsh Session Log through encrypted Session Persistence |
| Workspace identity and session membership | dsh Workspace Registry |
| Manifest, lockfile, snapshot metadata, observed/applied state | `workbench-runtime` |
| Task, node, routing, candidate, `ExecutionApproval`, `ChangeApproval`, and DevFlow correlation projections | `workbench-governed-tasks` |
| Canonical governed Intent, Action, Evidence, State, Decision | DevFlow EventStore |
| Knowledge metadata and reviewed memory | `workbench-knowledge` |
| Trajectory, evaluator configuration, raw evidence, derived scores | `workbench-evaluation` |

`workbench-governed-tasks` may store trusted Evidence identifiers, Decision identifiers, and display projections, but it cannot originate or overwrite canonical DevFlow Evidence, State, or Decision. Every projection is rebuildable from its authoritative source.

New plugin state uses the dsh Storage interface. Large artifact content is stored as content-addressed files. Plugin storage contains hashes, locations, scopes, versions, and provenance rather than duplicate large content. Legacy Workbench JSONL is migration input and a read-only archive, never the new runtime store.

Migration may read legacy `.workbench` data and dsh data concurrently, but writes go to only one owner. No dual-write migration is permitted.

### Session privacy and encryption

dsh Session history is operational product data, not governance audit data. Complete user messages, model messages, tool events, and stream chunks may be persisted only through a Workbench-selected encrypted Session Persistence provider.

- Records are encrypted with AES-256-GCM using a fresh nonce per record or authenticated segment.
- A random installation master key is stored through dsh Credentials in the operating system credential store; it is never written beside session data.
- Sessions expire after 30 days by default. Users may pin a session or delete it immediately.
- Deletion removes the encrypted session data and associated unreferenced artifacts while preserving separately required redacted governance records.
- A missing or unreadable key makes the affected sessions unavailable with an explicit recovery diagnostic; the provider never creates a replacement key over existing ciphertext.
- Governance audit, trajectory, benchmark exchange, and Evidence projections continue to exclude raw prompt, raw context, stdout, and stderr, storing only digests, byte counts, safe summaries, paths, identifiers, and provenance.

## 13. Governed Task Flow

```text
1. WebUI or tool submits a task to ctx.governedTasks.
2. The plugin validates or constructs the deterministic TaskGraph.
3. The plugin creates one detached Git worktree and supervisor dsh Session for the run.
4. Ready nodes are routed to child dsh Agent/Subagent Sessions whose complete execution world is bound to that worktree.
5. dsh obtains `ExecutionApproval` where a candidate-worktree tool policy requires it.
6. Workbench records Agent output as Evidence Claims and collects candidate files.
7. The WebUI presents the exact candidate digest and diff for `ChangeApproval`.
8. Without `ChangeApproval`, the run remains AWAITING_APPROVAL and no canonical mutation occurs.
9. After `ChangeApproval`, the DevFlow adapter submits the version-bound Action and immutable correlation identifiers.
10. DevFlow alone applies through its Action Gateway and emits trusted verifier Evidence.
11. Workbench maps a valid finish Decision to COMPLETED and projects the result into dsh-visible status.
```

A cancellation, deadline breach, invalid candidate, approval mismatch, failed verifier, corrupt EventStore, or uncertain recovery prevents completion. Corrupt or uncertain governed state becomes quarantined rather than guessed or silently repaired.

## 14. WebUI Extension Design

The WebUI is extended in this order:

1. Client Plugin and documented registration interfaces.
2. The thin Web shell registration interface.
3. Domain-owned typed Remote methods, routes, pages, and Conversation Node renderers.
4. Settings Cards for Workbench configuration.
5. General navigation or page extension contributed upstream to dsh.
6. The single temporary extension patch allowed by Section 4.

Workbench business behavior never lives in the patch. The patch may only make a generic extension contribution possible. If the required result needs business-page or application-framework modifications, WebUI migration stops until dsh provides the seam; a second frontend is not created.

The WebUI listens on loopback by default. Mutating Remote methods validate Origin and CSRF protection in addition to their domain authorization. Non-loopback access is deferred until an authenticated, TLS-protected deployment design is approved; an unauthenticated remote client never receives approval controls.

The first WebUI release contains functional workspace, task, approval, and Evidence contributions. Knowledge and evaluation contributions are added when their plugins migrate. Visual redesign follows functional parity and upgrade compatibility.

## 15. Failure Isolation

- Unsupported dsh version: Workbench Profile refuses activation with the required exact version and detected version; default dsh profiles remain usable.
- Optional plugin unavailable: dependent Workbench navigation and tools are hidden or marked unavailable; unrelated dsh capabilities continue.
- Required core plugin unavailable: governed mutations are disabled; read-only status remains available when safe.
- DevFlow unavailable: candidates may be preserved, but approval cannot cause mutation and completion cannot be reported.
- Storage migration failure: legacy data remains untouched; the new plugin refuses write activation.
- Web Client incompatibility: Host plugins remain usable through Headless/commands; the candidate dsh upgrade is rejected.
- Temporary patch conflict: dependency installation or CI fails before packaging.
- Session key missing or unreadable: encrypted sessions remain untouched and unavailable; the system does not replace the key or discard ciphertext.
- Failed, quarantined, or awaiting-approval run: its worktree is retained for seven days with path, digest, and expiry metadata. Users may delete it early or pin it. Successfully verified worktrees are cleaned automatically.

## 16. Migration Route

### Phase 0: Compatibility spike

Prove an out-of-tree Profile, Host Plugin, Client Plugin, Remote call, Conversation Node, Settings Card, Workspace access, Agent/Subagent execution, complete candidate-worktree execution binding, encrypted Session Persistence, Sandbox use, and one dsh version upgrade. Select and lock the exact dsh release only after this gate passes.

The spike is a hard architecture gate. Migration stops if plugins cannot guarantee candidate-only Filesystem/Shell/PTY/LSP/Subprocess execution, encrypted sessions, distinct approval semantics, or both Web and Headless activation. Host-core patches cannot waive these failures.

### Phase 1: Plugin skeleton

Adopt Node.js 24 LTS and the exact repository pnpm version. Create the narrow `dsh-compat`, synchronized Workbench release metadata, the Workbench Profile, and the three initial plugins. Boot dsh Web and Headless with and without the Workbench Profile.

### Phase 2: Governed vertical slice

Deliver one path: open workspace, submit one-node task, create a detached run worktree and supervisor/child Sessions, edit one UTF-8 file through the candidate-bound dsh execution world, review the diff, issue a digest-bound `ChangeApproval`, apply through DevFlow, verify, and display Evidence and Decision.

No bulk migration starts before this slice passes.

Starting with this phase, the old core is feature-frozen. It receives only severe correctness or security fixes until cutover.

### Phase 3: Workspace Runtime parity

Migrate manifest, detect, plan, apply, verify, project sync, lockfile, snapshot, restore, rollback, configuration, and secret-reference behavior into `workbench-runtime`. Compare new read results with the existing implementation; never dual-write mutations.

### Phase 4: Governed task parity

Migrate deterministic DAGs, pipelines, routing, concurrency, retry, fallback, review, replan, resume, approval, DevFlow, Evidence, and audit behavior. Replace process-based generic Agent and Planner invocation with dsh Agent/Subagent execution.

### Phase 5: Web product parity

Deliver the thin Web shell plus domain-owned workspace, task, approval, Evidence, and audit contributions. Preserve dsh session functionality, enforce loopback and request-integrity controls, and validate both Web and Headless operation.

### Phase 6: Knowledge and evaluation migration

Move accepted Level 3 and Level 4 behavior into their plugins. Add their Web contributions only after Host contract tests pass.

### Phase 7: Cutover and cleanup

Migrate one workspace at a time. Lock the selected workspace, run an import dry-run, create a complete backup, import into versioned dsh Storage, validate counts and hashes, then write a schema marker before enabling new writes. Retain legacy data permanently read-only. The previous release may be used only before the first new-system write; after that point the workspace permits forward repair, not binary or data-schema downgrade. Delete duplicate implementations only after equivalent acceptance tests pass.

### Phase 8: Continuous dsh upgrade lane

For every candidate dsh release: install, type-check, run compatibility contracts, run plugin tests, boot Web and Headless, run the governed vertical slice, validate the temporary patch if present, run legacy-data compatibility tests, and require explicit promotion. A failed release is recorded and may be skipped without widening the supported-version set.

### Phase 9: Resume product roadmap

Implement or migrate evolution, intelligence, evidence graph, experiment, and package goals as independently accepted phases. They may not weaken the trusted completion rule established by `workbench-governed-tasks`.

### Planning decomposition

This architecture is intentionally larger than one implementation plan. Execution must be decomposed into the following independently reviewed plans:

1. dsh compatibility spike, Node/pnpm migration, and locked-version selection.
2. Workbench Profile, compatibility library, and plugin skeleton.
3. Governed vertical slice.
4. Workspace Runtime parity migration.
5. Governed task parity migration.
6. Workbench WebUI parity migration.
7. Knowledge and evaluation plugin migration.
8. Per-workspace legacy import, forward-only cutover, cleanup, and continuous upgrade lane.

Each plan must deliver working, testable software and satisfy its own exit gate before the next plan begins. Later product-roadmap plugins receive separate designs and plans when their phase starts.

## 17. Testing Strategy

Tests cross the same interfaces used by callers.

1. `dsh-compat` contract tests against the exact locked dsh version.
2. Plugin interface tests with dsh-provided test support where available.
3. A Level 1-4 behavior-contract matrix mapping every accepted invariant to its replacement test and recorded evidence; test-count equality is not required.
4. Execution-world tests proving Filesystem, Shell, PTY, LSP, Subprocess, Agent, and Subagent cannot write outside the candidate worktree.
5. Encrypted Session Persistence tests covering confidentiality, tamper detection, retention, deletion, pinning, missing keys, and restart recovery.
6. Distinct `ExecutionApproval` and `ChangeApproval` contract tests, including digest, expiry, actor, revision, and cross-use rejection.
7. Web Host/Client contract, loopback, Origin/CSRF, capability-discovery, and browser smoke tests.
8. Governed vertical-slice E2E with a real temporary Git repository and real DevFlow stable protocol.
9. Per-workspace legacy import dry-run, locking, backup, idempotency, interrupted import, schema-marker, and forward-repair tests.
10. Upgrade tests against the current locked version and one candidate released version.

The migration gate starts from the accepted Level 4 behavior represented by the 414-test baseline. A module is removed only after every mapped behavior contract passes twice from clean checkouts and its phase acceptance document records the evidence.

## 18. Release and Rollback

The Workbench Profile, compatibility library, and all shipping Workbench plugins use one synchronized release version. Every Workbench release records:

- exact dsh version;
- Workbench Profile and plugin versions;
- compatibility module version;
- storage schema versions;
- temporary patch identity, if present;
- acceptance evidence and rollback target.

Before a workspace accepts its first new-system write, rollback restores the previous Workbench release and lockfile and reopens untouched legacy data. After the first new-system write, normal rollback is replaced by forward repair; an older binary is not allowed to open the migrated workspace. The pre-migration backup is disaster recovery and may be restored only with explicit acknowledgement that post-backup writes will be lost. Legacy data is never deleted automatically. Schema migrations are append-only or create a new versioned store.

## 19. Acceptance Criteria

The architecture migration is complete when:

- Workbench starts as an out-of-tree dsh Profile without a dsh product fork.
- The product runs on Node.js 24 LTS and the repository's exact pnpm version.
- Default dsh Web and Headless profiles still start without Workbench plugins.
- Phase 0 proves the architecture without Host-core security patches.
- The governed vertical slice completes through dsh Agent execution and DevFlow trusted verification.
- All Agent-visible Filesystem, Shell, PTY, LSP, Subprocess, Agent, and Subagent capabilities are candidate-worktree bound; the canonical workspace is not writable before DevFlow authorization.
- No path reports completion from dsh execution success alone.
- Complete dsh sessions are encrypted and lifecycle-managed; governance and evaluation projections remain raw-content-free.
- `ExecutionApproval` and `ChangeApproval` cannot substitute for one another.
- Workspace Runtime behavior is equivalent to the accepted existing behavior.
- Every Level 1-4 orchestration, pipeline, knowledge, and evaluation invariant is present in the behavior-contract matrix and remains covered.
- Workbench WebUI uses plugin and Remote extension mechanisms; any remaining patch satisfies Section 4.
- The WebUI is loopback-only until a separate authenticated remote-access design is approved.
- A candidate dsh version can be evaluated without merging upstream source into this repository.
- The repository contains only one Agent Loop, Session system, generic Tool Registry, and base Web server: those supplied by dsh.
- Legacy data can be imported idempotently and remains recoverable.
- A migrated workspace rejects older binaries after its first new-system write and supports forward repair from a recorded backup.

## 20. Deliberate Deferrals

- Automatic unattended promotion of dsh updates.
- Supporting more than one dsh version at a time.
- Reverse data migration to an older Workbench binary after first new-system write.
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
- [DeepSeek Harness Session persistence catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/persistence-catalog.md)
- [DeepSeek Harness Approval subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/approval.md)
- [DeepSeek Harness Development prerequisites](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/development.md)
- Existing Workbench Level 2-7 execution plan: `docs/superpowers/plans/2026-08-23-agent-workbench-level-2-to-7-execution.md`
- Existing acceptance records: `docs/level-2-acceptance.md`, `docs/level-3-acceptance.md`, `docs/level-4-acceptance.md`
