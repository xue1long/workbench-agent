# DSH-Core Agent Workbench Architecture Design

**Date:** 2026-08-23

**Status:** Revised after fourth architecture audit; approved for implementation planning

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
11. Bind every human change approval to an immutable candidate snapshot and the exact canonical state it may modify.
12. Keep secret values outside model-visible and persisted Session data, even when Session storage is encrypted.
13. Make every approval source attributable to a trusted local or configured automation identity.

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

Production and upgrade-candidate installs use the repository package manager with `--frozen-lockfile` and verify lockfile integrity. Every promoted release records a dependency manifest or SBOM, third-party license notices, and vulnerability-scan evidence. Known-exploited, Critical, and applicable High vulnerabilities block promotion. Any other accepted finding requires a named owner, rationale, and expiry; an expired exception blocks the next build or upgrade.

The dsh source tree is treated as read-only. Workbench behavior is mounted through an out-of-tree Profile and Bundle. Discovery of a new release creates an upgrade candidate; ordinary releases must be evaluated within 30 days and security releases within 72 hours. Promotion occurs only after compatibility, WebUI, migration, and governed-task tests pass. A failed candidate does not force support for that version: Workbench remains on the current locked version and may evaluate a later release directly.

One temporary WebUI patch is permitted only when dsh lacks a necessary general extension point. The patch must:

- live in one `patches/` entry;
- add extension plumbing rather than Workbench business behavior;
- apply automatically in CI against the locked dsh version;
- have a linked upstream contribution or documented removal condition;
- block a dsh upgrade if it no longer applies cleanly.

No Host, Agent Loop, Session, Tool, Sandbox, or Storage source patch is allowed.

For a critical upstream vulnerability, Workbench first disables the affected capability. If disabling it cannot make the product safe, a temporary security build may pin an exact reviewed upstream commit. That build requires reproducible package artifacts with recorded source commit, build parameters, and checksums; a linked upstream Issue or pull request; the complete release gate; and review every seven days. It must never become a permanent fork.

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

Mutation ownership is explicit and non-overlapping. Writes inside the Git repository are owned by DevFlow unless they target an explicitly listed Workbench-private metadata directory. `workbench-runtime` owns repository-external host environment state, tool installations, Workbench runtime configuration, snapshots, and project bootstrap resources. Every mutating manifest step declares its owner, resource kind, and target; an unclassified or multiply owned target is rejected before execution.

`RuntimeApproval` authorizes one exact deterministic Runtime plan, including apply, sync, restore, and rollback. It binds workspace identity, plan digest, observed-state revision and preconditions, resource kinds and targets, authenticated actor, issue time, and expiry. A state mismatch or changed plan requires new approval. `RuntimeApproval`, `ExecutionApproval`, and `ChangeApproval` have distinct identifiers, UI labels, audit records, and error types and can never substitute for one another.

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

Every governed run has one isolated candidate checkout. The preferred checkout is a detached Git worktree only when the Phase 0 sandbox proves that Agent-visible Filesystem, Shell, PTY, LSP, Subprocess, Agent, and Subagent execution cannot follow the worktree Git administration link into the canonical repository's `.git` data. Git control-plane operations and shared Git metadata are never exposed to the Agent. If that isolation cannot be enforced, the selected implementation is one disposable full clone with independent Git metadata; the product does not switch modes dynamically. Model-visible and tool capabilities receive the selected candidate checkout as their only workspace root. The canonical working tree, refs, index, configuration, and object database are not writable or passed to the Agent. Each node declares `executionMode: read-only | mutating`. A read-only node receives only enforced read-only providers and tools; undeclared or unverifiable nodes are treated as mutating.

Mutating node attempts execute serially from the latest verified run-local checkpoint. Checkpoints are Workbench-controlled content snapshots outside shared Git metadata, not Agent-created commits or index state. A successful attempt creates the next checkpoint; a failed, timed-out, cancelled, fallback, or retried attempt restores the prior checkpoint before any later node starts. Read-only nodes may overlap only with other read-only nodes on the same immutable checkpoint and never with a mutating attempt. Parallel mutating checkouts and merge orchestration are deferred until measured need.

Every governed run owns one supervisor dsh Session. Each node attempt owns one child Session. Correlation data is an append-only event stream because its identifiers arise at different stages. Existing events are never updated; a rebuildable projection presents the current run view:

```text
RunCreated(workbenchRunId)
SupervisorSessionBound(supervisorSessionId)
NodeAttemptStarted(nodeId, attempt, childSessionId)
CandidateSnapshotted(candidateDigest, baseCommit, stateRevision)
ChangeApproved(changeApprovalId)
DevFlowSessionReserved(devflowSessionId)
ApprovalDispatchStarted(actionId, actionDigest, idempotencyKey)
ApprovalDispatchConfirmed(actionId)
RunCompleted(decisionId)
```

The two governed-task approval kinds are intentionally separate:

- `ExecutionApproval` is dsh's one-shot authorization for a tool action inside the candidate checkout.
- `ChangeApproval` is Workbench authorization to submit one immutable Action envelope to DevFlow. It binds workspace identity, Intent identity and version, policy version, required acceptance and verifier definitions, base commit, state revision, Candidate Snapshot digest, every target entry precondition, authenticated actor, issue time, and expiry. Each target entry contains its normalized canonical path, expected kind (`absent` or `regular`), expected content digest, and expected file mode. Symbolic links, path aliases, case-colliding targets, and paths whose resolved location escapes the repository are rejected.

An `ExecutionApproval` can never satisfy a `ChangeApproval`; the identifiers, UI labels, audit records, and error types are distinct.

Candidate collection freezes the complete edit payload before approval. Collection and application both validate target identity with `lstat`, normalized path comparison, and resolved-path containment. `actionDigest` is SHA-256 over a canonical serialization of the complete bound Action envelope, including workspace identity and verification policy; it is also the workspace-scoped idempotency key. Submission revalidates the Action digest, snapshot digest, base commit, state revision, verification policy, and every target entry precondition against canonical state. Any mismatch, expiry, different Action, or post-snapshot candidate change invalidates the approval and requires a new snapshot and approval.

A `ChangeApproval` authorizes one logical Action, not one transport attempt. `workbench-governed-tasks` owns an internal durable dispatch state machine:

```text
APPROVED → DISPATCHING → CONFIRMED | REJECTED
```

The stable `actionId`, `actionDigest`, `idempotencyKey`, caller-known `devflowSessionId`, and Candidate Snapshot digest are committed atomically before the first DevFlow call. An identical retry may redeliver only that Action under the same idempotency key; the approval cannot authorize a different Action, candidate, workspace, or verification policy. After restart or an uncertain response, Workbench recovers by the reserved DevFlow Session identifier or queries the stable idempotency key before retrying. If the DevFlow protocol supports neither method, Phase 0 fails. An unresolved outcome is quarantined. This state machine and its outbox remain internal to the deep `ctx.governedTasks` module.

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
| Manifest, lockfile, snapshot metadata, observed/applied state, `RuntimeApproval` | `workbench-runtime` |
| Task, node, routing, candidate, `ExecutionApproval`, `ChangeApproval`, and DevFlow correlation projections | `workbench-governed-tasks` |
| Canonical governed Intent, Action, Evidence, State, Decision | DevFlow EventStore |
| Knowledge metadata and reviewed memory | `workbench-knowledge` |
| Trajectory, evaluator configuration, raw evidence, derived scores | `workbench-evaluation` |

`workbench-governed-tasks` may store trusted Evidence identifiers, Decision identifiers, and display projections, but it cannot originate or overwrite canonical DevFlow Evidence, State, or Decision. Every projection is rebuildable from its authoritative source.

New plugin state uses the dsh Storage interface. Large artifact content is stored as content-addressed files. Plugin storage contains hashes, locations, scopes, versions, and provenance rather than duplicate large content. Legacy Workbench JSONL is migration input and a read-only archive, never the new runtime store.

Phase 0 must prove that the selected dsh Storage path provides workspace namespacing, atomic commit, exclusive migration locking, durable schema markers, crash recovery, and idempotent replay. It must also prove that a plugin can register or replace the provider through a usable dsh seam. If native Storage lacks required semantics but the seam exists, Workbench supplies one minimal persistence provider behind that interface; business plugins do not implement separate stores. If neither path works, migration stops rather than creating a side-channel store.

Migration may read legacy `.workbench` data and dsh data concurrently, but writes go to only one owner. No dual-write migration is permitted.

### Session privacy and encryption

dsh Session history is operational product data, not governance audit data. Complete user messages, model messages, tool events, and stream chunks may be persisted only through a Workbench-selected encrypted Session Persistence provider.

- Each record is independently encrypted with AES-256-GCM using a unique random 96-bit nonce. Authenticated additional data contains the storage format version, session identifier, sequence number, and event type. Each record stores its non-secret `keyId` so later key rotation does not require guessing.
- A random installation master key is stored through dsh Credentials in the operating system credential store; it is never written beside session data.
- Secret values are resolved only inside trusted credential-consuming adapters. Agent-controlled Filesystem, Shell, PTY, generic Subprocess, prompts, Session events, and governance projections receive secret references or redacted values, never credentials. An MCP or external tool that needs a credential receives it only in its isolated adapter process and must not echo it through tool results. Redaction occurs before model exposure and persistence and is required even though the Session store is encrypted.
- Sessions expire after 30 days by default. Users may pin a session or delete it immediately.
- Deletion removes the encrypted session data and associated unreferenced artifacts while preserving separately required redacted governance records.
- A missing or unreadable key makes the affected sessions unavailable with an explicit recovery diagnostic; the provider never creates a replacement key over existing ciphertext.
- Version 1 encrypted sessions are installation-bound and cannot be restored on another machine by copying the workspace. Any future export is an explicit, separately designed decrypted-and-redacted artifact rather than a copy of the encrypted store.
- Governance audit, trajectory, benchmark exchange, and Evidence projections continue to exclude raw prompt, raw context, stdout, and stderr, storing only digests, byte counts, safe summaries, paths, identifiers, and provenance.

## 13. Governed Task Flow

```text
1. WebUI or tool submits a task to ctx.governedTasks.
2. The plugin validates or constructs the deterministic TaskGraph.
3. The plugin creates one isolated candidate checkout and supervisor dsh Session for the run.
4. Ready nodes are routed to child dsh Agent/Subagent Sessions whose complete execution world is bound to that checkout and excludes Git control-plane metadata.
5. dsh obtains `ExecutionApproval` where a candidate-checkout tool policy requires it.
6. Each mutating node attempt starts from the latest verified checkpoint; Workbench restores failures and checkpoints successes. Read-only nodes run only against an immutable checkpoint.
7. Workbench records Agent output as Evidence Claims and freezes a Candidate Snapshot containing the complete edits, base commit, state revision, and normalized target entry preconditions.
8. The WebUI presents that exact Candidate Snapshot digest and diff for `ChangeApproval`.
9. Without `ChangeApproval`, the run remains AWAITING_APPROVAL and no canonical mutation occurs.
10. After `ChangeApproval`, Workbench atomically persists the stable Action, reserved DevFlow Session identifier, and DISPATCHING outbox state; revalidates every bound precondition and verification policy; and submits the frozen payload. A mismatch returns the run to candidate review; it never applies stale approval.
11. DevFlow alone applies through its Action Gateway and emits trusted verifier Evidence. Identical delivery retries use the same idempotency key.
12. Workbench reconciles uncertain dispatches, records confirmation, maps a valid finish Decision to COMPLETED, and projects the result into dsh-visible status.
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

The WebUI listens on loopback by default. Mutating Remote methods validate Origin and CSRF protection in addition to an authenticated local session. The authenticated actor is derived server-side and cannot be supplied or overridden by the request body. Workbench reuses a verified dsh local-authentication session when available; otherwise it uses an unguessable launch-scoped credential that is excluded from URLs and logs. If neither can be provided safely, WebUI mutation and approval controls remain disabled. Non-loopback access is deferred until an authenticated, TLS-protected deployment design is approved.

The same identity rule applies outside the WebUI. Interactive Headless and command approval derives the actor from the operating-system principal. Non-interactive approval requires a preconfigured trusted automation identity and records its authentication method. A caller-provided display name is never accepted as approval identity.

The first WebUI release contains functional workspace, task, approval, and Evidence contributions. Knowledge and evaluation contributions are added when their plugins migrate. Visual redesign follows functional parity and upgrade compatibility.

## 15. Failure Isolation

- Unsupported dsh version: Workbench Profile refuses activation with the required exact version and detected version; default dsh profiles remain usable.
- Optional plugin unavailable: dependent Workbench navigation and tools are hidden or marked unavailable; unrelated dsh capabilities continue.
- Required core plugin unavailable: governed mutations are disabled; read-only status remains available when safe.
- DevFlow unavailable: candidates may be preserved, but approval cannot cause mutation and completion cannot be reported.
- Approval dispatch interrupted or uncertain: reconcile the stable Action and idempotency key with DevFlow; quarantine the run if the outcome cannot be proven.
- Storage migration failure: legacy data remains untouched; the new plugin refuses write activation.
- Storage capability failure: Workbench uses the approved minimal provider or refuses write activation; it never assumes missing atomicity or locking.
- Runtime plan or observed-state mismatch: `RuntimeApproval` is invalidated and no apply, sync, restore, or rollback step begins.
- Web Client incompatibility: Host plugins remain usable through Headless/commands; the candidate dsh upgrade is rejected.
- Temporary patch conflict: dependency installation or CI fails before packaging.
- Session key missing or unreadable: encrypted sessions remain untouched and unavailable; the system does not replace the key or discard ciphertext.
- Candidate or canonical-state mismatch after approval: the approval is invalidated, no mutation occurs, and a new snapshot requires new approval.
- Mutating node attempt failure: restore the prior verified checkpoint before retry, fallback, or later-node execution.
- Failed, quarantined, or awaiting-approval run: its candidate checkout is retained for seven days with owner-only filesystem permissions, path, digest, and expiry metadata. Users may delete it early or pin it. Cleanup failure is surfaced and retried; successfully verified checkouts are cleaned automatically. Candidate retention never includes resolved credentials.

## 16. Migration Route

### Phase 0: Compatibility spike

Prove an out-of-tree Profile, Host Plugin, Client Plugin, Remote call, authenticated Web and Headless approval, Conversation Node, Settings Card, Workspace access, Agent/Subagent execution, complete candidate-checkout execution binding, denial of Agent access to shared Git administration data, encrypted and pre-persistence-redacted Session Persistence, trusted-adapter-only secret injection, Sandbox use, required Storage atomicity/locking/recovery/provider-registration semantics, stable DevFlow recovery by reserved Session identifier or idempotency key, and one dsh version upgrade. Scan Session stores, candidate checkouts, temporary files, journals/WAL, indices, and error logs to prove secret values are absent. Select and lock the exact dsh release and one candidate-checkout isolation mode only after this gate passes.

The spike is a hard architecture gate. Migration stops if plugins cannot guarantee candidate-only Filesystem/Shell/PTY/LSP/Subprocess execution without shared Git metadata access, checkpoint-restored attempts, immutable-checkpoint read concurrency, secret-safe encrypted sessions, trusted approval identity on every interface, recoverable DevFlow dispatch, required Storage semantics or provider registration, distinct approval semantics, or both Web and Headless activation. Host-core patches cannot waive these failures.

### Phase 1: Plugin skeleton

Adopt Node.js 24 LTS and the exact repository pnpm version. Enforce frozen-lockfile installation, integrity verification, dependency inventory, license notices, and vulnerability scanning. Create the narrow `dsh-compat`, synchronized Workbench release metadata, the Workbench Profile, and the three initial plugins. Boot dsh Web and Headless with and without the Workbench Profile.

### Phase 2: Governed vertical slice

Deliver one path: open workspace, submit one-node task, create the selected isolated candidate checkout and supervisor/child Sessions, edit one UTF-8 regular file through the candidate-bound dsh execution world, freeze a Candidate Snapshot and canonical Action envelope, review the diff and verification policy, issue a logical-Action-bound `ChangeApproval`, persist the recovery key and dispatch state, revalidate canonical state, apply through DevFlow, verify, and display Evidence and Decision. The slice must prove that modifying the candidate, canonical target, workspace identity, or verification policy after approval prevents application; identical delivery retry is idempotent; an uncertain response is reconciled; and a different Action cannot reuse the approval.

No bulk migration starts before this slice passes.

Starting with this phase, the old core is feature-frozen. It receives only severe correctness or security fixes until cutover.

### Phase 3: Workspace Runtime parity

Migrate manifest, detect, plan, apply, verify, project sync, lockfile, snapshot, restore, rollback, configuration, and secret-reference behavior into `workbench-runtime`. Classify every mutating step by resource kind and target, using DevFlow as the default owner inside the repository and Runtime outside it. Require an authenticated, plan-digest-bound `RuntimeApproval` for every mutation and invalidate it when observed state changes. Compare new read results with the existing implementation; never dual-write mutations.

### Phase 4: Governed task parity

Migrate deterministic DAGs, pipelines, routing, concurrency, retry, fallback, review, replan, resume, approval, DevFlow, Evidence, and audit behavior. Replace process-based generic Agent and Planner invocation with dsh Agent/Subagent execution.

### Phase 5: Web product parity

Deliver the thin Web shell plus domain-owned workspace, task, approval, Evidence, and audit contributions. Preserve dsh session functionality, enforce loopback and request-integrity controls, and validate both Web and Headless operation.

### Phase 6: Knowledge and evaluation migration

Move accepted Level 3 and Level 4 behavior into their plugins. Add their Web contributions only after Host contract tests pass.

### Phase 7: Cutover and cleanup

Migrate one workspace at a time. Lock the selected workspace, run an import dry-run, create a complete backup, import into versioned dsh Storage, validate counts and hashes, then write a schema marker before enabling new writes. Retain legacy data permanently read-only. The previous release may be used only before the first new-system write; after that point the workspace permits forward repair, not binary or data-schema downgrade. Delete duplicate implementations only after equivalent acceptance tests pass.

### Phase 8: Continuous dsh upgrade lane

For every candidate dsh release: install from the frozen lockfile, verify integrity, generate the dependency inventory and license notices, scan dependencies and enforce the vulnerability policy, type-check, run compatibility contracts, run plugin tests, boot Web and Headless, run the governed vertical slice, validate the temporary patch if present, run legacy-data compatibility tests, and require explicit promotion. A failed release is recorded and may be skipped without widening the supported-version set.

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
4. Execution-world tests proving Filesystem, Shell, PTY, LSP, Subprocess, Agent, and Subagent cannot write outside the candidate checkout, dereference a worktree Git administration link, or mutate canonical Git refs, index, configuration, objects, or working-tree files.
5. Execution-mode and checkpoint tests proving failed attempts leave no changes, successful attempts advance the checkpoint, only read-only nodes on the same immutable checkpoint overlap, and undeclared nodes fail closed to mutating mode.
6. Encrypted Session Persistence tests covering per-record nonce uniqueness, authenticated metadata, confidentiality, tamper detection, pre-persistence secret redaction, retention, deletion, pinning, installation binding, missing keys, and restart recovery.
7. Distinct `RuntimeApproval`, `ExecutionApproval`, and `ChangeApproval` contract tests, including cross-use rejection, authenticated Web/Headless/automation actors, Runtime plan and observed-state binding, logical-Action binding, workspace and verification-policy binding, stable idempotent retry, different-Action rejection, snapshot digest, base commit, normalized path, target existence/kind/mode/digest, symlink and case-collision rejection, expiry, state revision, and candidate/canonical mutation rejection.
8. Dispatch-outbox and correlation-event replay tests covering atomic recovery-key persistence, crashes before and after DevFlow acceptance, recovery by reserved Session identifier or idempotency key, reconciliation, projection rebuild, and immutable historical events.
9. Storage capability tests covering workspace isolation, atomic commit, locking, schema markers, crash recovery, idempotent replay, and provider registration/replacement.
10. Web Host/Client contract, loopback, authenticated actor, launch-credential secrecy, Origin/CSRF, capability-discovery, and browser smoke tests.
11. Governed vertical-slice E2E with a real temporary Git repository and real DevFlow stable protocol.
12. Per-workspace legacy import dry-run, locking, backup, idempotency, interrupted import, schema-marker, and forward-repair tests.
13. Upgrade tests against the current locked version and one candidate released version, including frozen-lockfile, integrity, inventory, license, vulnerability-policy, exception-expiry, and emergency-build reproducibility gates.

The migration gate starts from the accepted Level 4 behavior represented by the 414-test baseline. A module is removed only after every mapped behavior contract passes twice from clean checkouts and its phase acceptance document records the evidence.

## 18. Release and Rollback

The Workbench Profile, compatibility library, and all shipping Workbench plugins use one synchronized release version. Every Workbench release records:

- exact dsh version;
- Workbench Profile and plugin versions;
- compatibility module version;
- storage schema versions;
- dependency inventory or SBOM identity, lockfile digest, license-notice digest, and vulnerability-scan evidence;
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
- All Agent-visible Filesystem, Shell, PTY, LSP, Subprocess, Agent, and Subagent capabilities are candidate-checkout bound and cannot reach shared Git administration data; the canonical working tree and Git metadata are not writable before DevFlow authorization.
- Mutating attempts start from verified checkpoints and cannot leak failed changes into retries or later nodes. Only capability-enforced read-only nodes on the same immutable checkpoint execute concurrently; they never overlap a mutating attempt.
- No path reports completion from dsh execution success alone.
- Complete dsh sessions are encrypted per record and lifecycle-managed; secret values are removed before model exposure or persistence; governance and evaluation projections remain raw-content-free.
- `RuntimeApproval`, `ExecutionApproval`, and `ChangeApproval` cannot substitute for one another, and every approval actor comes from a trusted authentication context.
- Every `RuntimeApproval` binds one exact plan and observed state; a changed plan, resource target, or precondition prevents Runtime mutation.
- Every `ChangeApproval` authorizes exactly one logical Action bound to workspace identity, verification policy, an immutable Candidate Snapshot, and canonical-state preconditions. Identical idempotent delivery may be retried, but any different Action, candidate, workspace, policy, path identity, file kind/mode, or target-state change prevents application.
- Approval dispatch survives process failure through a durable outbox and DevFlow reconciliation; an unprovable outcome is quarantined.
- Correlation history is append-only and its current view can be rebuilt without mutating historical events.
- Required Storage atomicity, locking, schema-marker, recovery, and idempotency semantics pass the Phase 0 gate.
- Required Storage semantics are available through native dsh Storage or a registered provider; otherwise migration stops.
- Runtime and DevFlow mutation ownership is explicit, non-overlapping, and enforced for every resource and target; repository writes default to DevFlow.
- Workspace Runtime behavior is equivalent to the accepted existing behavior.
- Every Level 1-4 orchestration, pipeline, knowledge, and evaluation invariant is present in the behavior-contract matrix and remains covered.
- Workbench WebUI uses plugin and Remote extension mechanisms; any remaining patch satisfies Section 4.
- The WebUI is loopback-only until a separate authenticated remote-access design is approved.
- Every WebUI, Headless, command, or automation approval actor comes from a trusted authentication context; mutation controls are disabled if that identity cannot be established.
- A candidate dsh version can be evaluated without merging upstream source into this repository.
- Production and candidate builds are reproducible from a frozen lockfile and retain dependency, license, integrity, and vulnerability evidence; the severity and expiring-exception policy gates promotion.
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
