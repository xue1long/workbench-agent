# Agent Workbench Level 2–7 Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the proven Workspace Runtime into an orchestrated, measurable, knowledge-aware system that can propose and validate improvements without allowing unverified behavior into production.

**Architecture:** Extend Workspace Runtime as the orchestration layer and integrate DevFlow Runtime as the governance layer. Workspace Runtime owns task DAGs, routing, bounded execution, provider invocation, worktree isolation, and observability projections; DevFlow Runtime owns governed Action authorization, canonical mutation, trusted Evidence, EventStore-derived State, recovery, and final Decision. Environment/config mutations continue through `applyPlan`; source-code candidates are prepared in an isolated Git worktree and submitted through the stable `devflow-runtime` file protocol. Basic trusted verification starts in Level 2; Level 4 adds comparative evaluation and analytics.

**Tech Stack:** Node.js 20+ ESM, Node built-in test runner, the existing zero-runtime-dependency CLI and web dashboard, plus the separately installed Python 3.11 DevFlow Runtime exposed through its UTF-8 JSON/YAML file protocol. Workspace observability projections remain JSON/JSONL until measured query volume requires SQLite.

**Spec:** `C:\Users\HP\OneDrive\007 - 个人笔记\000 Inbox\2026-08-23 Agent Workbench — Level 2 至 Level 7 实施方案.md`

## Global Constraints

- Preserve `Detect → Plan → Permission Check → Apply → Verify` for existing environment/config mutations that are outside a governed DevFlow session.
- Preserve `Sandbox → Diff → Action Proposal → DevFlow Action Gateway → Trusted Verify → Decision` for governed source-code mutations. No Workbench component may apply the candidate patch directly to the user's workspace.
- LLMs may plan, interpret, summarize, generate, and reflect; deterministic validation, dependency resolution, permissions, Git state, and test results remain programmatic.
- Every governed task run binds `taskId`/`runId` to DevFlow `session_id`, `intent_version`, `policy_version`, `state_revision`, `idempotency_key`, and verifier versions.
- Agent output is an `EvidenceClaim`, never trusted Evidence. Only Runtime/Verifier output with provenance and `verifier_version` may satisfy a required acceptance.
- DevFlow EventStore is the sole source of truth for governed Intent, Action, Evidence, State, and Decision. `AuditLog` and `StateStore` are rebuildable Workbench observability/read-model projections only.
- Workflow execution success is not final completion. Only `Decision.kind == 'finish'` with valid EventStore integrity may produce a user-visible completed result.
- Raw prompts, raw context, stdout, and stderr are not persisted in Level 2. Persist hashes, byte counts, safe summaries, file paths, and evidence metadata only.
- Existing history is append-only. Corrections are new records that reference superseded records.
- Any behavior-changing candidate needs a baseline, benchmark result, explicit approval, version, and rollback target.
- Do not add a database, queue, vector store, graph database, or frontend framework before its phase gate demonstrates a measurable need.
- Every implementation task begins with a failing test and ends with `npm test` passing.
- A live Agent may edit only an isolated Git worktree. The trusted Workbench control plane must record explicit human approval before its Runtime adapter may submit an Action; the Agent process never receives that adapter or the governed workspace as an execution target.

---

## 1. Confirmed Baseline

The workspace currently provides:

- manifest validation, observed/applied state, planning, adapters, and safe apply;
- Agent, MCP, Package, Project, and secret-reference models;
- JSONL execution/audit persistence with redaction;
- lockfile, snapshot, rollback, sync, and restore;
- CLI and read-only web dashboard;
- 186 passing tests on 2026-08-23.

Observed execution blockers on 2026-08-23:

- the workspace is not currently a Git repository;
- Claude CLI is not installed;
- the packaged Codex desktop executable is discoverable but cannot be launched as a CLI subprocess from this workspace.

### Phase 0 — Execution readiness

Readiness work is staged; do not treat all implementation as one gate:

- **Repository gate:** `git rev-parse --show-toplevel` succeeds. If it fails, stop and ask the user whether to initialize this directory or attach it to an existing repository; never run `git init` without that approval.
- **Provider gate:** at least one configured Agent provider completes a no-op invocation in a temporary Git worktree and returns a structured exit result. Detection alone is insufficient.
- **Runtime gate:** the pinned DevFlow Runtime checkout passes its complete pytest suite and the stable protocol proves correct multi-file payload handling, configured test verification, and isolation of two consecutive sessions in one workspace. `devflow-runtime --workspace <temp-repo> status` must return valid JSON with valid EventStore integrity. Do not waive red tests.

**Allowed work by gate:**

- Phase 0 Runtime compatibility fixes may start immediately in the separate DevFlow Runtime repository.
- After the Repository gate and baseline `npm test` pass, Tasks 1–6 may be implemented and committed in an isolated Workbench worktree; they use deterministic fixtures and do not require a live provider or Runtime integration.
- Tasks 7–12 may start only after Repository, Provider, and Runtime gates all pass. No live governed task or Level 2 completion claim is allowed earlier.

Readiness sequence:

- [ ] Run `npm test`; expected: 186 or more tests, zero failures.
- [ ] Pass the Repository gate, then run `git status --short`; record unrelated user changes and exclude them from implementation commits.
- [ ] Pass the Provider gate with a harmless prompt that creates no changes.
- [ ] Record the DevFlow Runtime commit/version, protocol version, and actual Python 3.11+ executable; from its checkout run `& '.\.venv\Scripts\python.exe' -m pytest -q` with zero failures. Do not assume the Windows `py` launcher exists.
- [ ] Repair the stale fixed-clock authorization fixtures, filter Kernel reduction by `session_id`, and let stable protocol config pass an explicit `test_command` into `RuntimeKernel`; cover each root fix with focused Runtime tests before the full suite.
- [ ] Enable Runtime only in a temporary fixture, then prove UTF-8 full-content single/multi-file Actions, trusted `test` Evidence, two isolated consecutive sessions, `status`, `run`, and `recover`. Do not integrate through the personal `dfr` wrapper.
- [ ] Create an isolated implementation worktree using `superpowers:using-git-worktrees`.
- [ ] Record the baseline test count, commit, Node version, OS, and provider version in `docs/level-2-acceptance.md`.

## 2. Delivery Model

Each level is an independently releasable product increment:

```text
L2 Orchestrate + trace
  ↓
L3 Execute a governed development pipeline + retrieve scoped knowledge
  ↓
L4 Evaluate against reproducible baselines
  ↓
L5 Produce and safely promote internal improvement candidates
  ↓
L6 Discover external candidate patterns with provenance
  ↓
L7 Connect evidence and run controlled experiments/package distribution
```

Trusted Evidence and fail-closed completion are Level 2 requirements. Level 3 expands artifact linkage; Level 4 adds reproducible comparison, scoring, and reporting without redefining the Level 2 trust boundary.

## 3. Release Sequence

### Release 2.0 — Capability Orchestration

**Detailed plan:** `docs/superpowers/plans/2026-08-23-level-2-capability-orchestration.md`

**Deliverables:**

- validated Task/SubTask DAG;
- validated Capability definitions, Agent mappings, and capability query API without a separate service or database;
- sequential, bounded-parallel, fan-out, and fan-in execution;
- deterministic rule/weighted Agent routing;
- retry, fallback, reviewer nodes, and callback-driven replan;
- a real planner provider and real Agent invocation boundary;
- isolated UTF-8 text source-change collection and conversion into a version-bound DevFlow `file_edit` Action whose `patch` fields contain complete new file contents;
- canonical mutation, trusted verification, recovery, and final Decision through DevFlow Runtime;
- Workbench events persisted as redacted projections while governed facts remain in DevFlow EventStore;
- CLI simulation plus one opt-in live end-to-end acceptance scenario.

**Exit gate:**

- [ ] Nine success fixtures complete and one expected-failure fixture is classified correctly; all ten judgments are reproducible.
- [ ] DAG validation rejects cycles and missing dependencies.
- [ ] A failed node blocks dependants but not independent branches.
- [ ] Retry never exceeds its configured limit.
- [ ] Fallback records why the primary Agent was replaced.
- [ ] Every governed run contains plan, routing decision, Evidence Claims, trusted Evidence references, duration, version bindings, EventStore integrity, and Decision.
- [ ] Re-running an already-converged mutation remains idempotent.
- [ ] One live provider completes the bounded OAuth fixture in at most five UTF-8 text files; Runtime applies it only after explicit approval and returns `finish` only after required `diff`, `scope`, and configured `test` acceptances bind trusted verifier evidence.
- [ ] Two independent governed runs execute consecutively in the same workspace without sharing Intent, revision, Evidence, blocking reasons, or terminal state.
- [ ] Unauthorized scope, stale revision, missing verifier evidence, corrupt EventStore, and uncertain recovery all forbid `finish`; uncertain state becomes `quarantined`.
- [ ] Existing 186 tests plus new Level 2 tests pass.

**Stop line:** Do not start Level 3 until all fixture outcomes match twice consecutively, the bounded live OAuth acceptance passes, Runtime and Workbench suites are green, two-session isolation passes, raw prompt/output content is absent from persistence, failed dependencies cannot execute, and no path can report final completion without a valid Runtime `finish` Decision.

### Release 3.0 — Development Pipeline and Scoped Knowledge

Create the detailed Level 3 plan only after Release 2.0 passes.

**Work package A — Development pipeline:**

- [ ] Add immutable pipeline templates composed of ordinary Level 2 DAG nodes.
- [ ] Ship the first template: `Requirement → Analysis → Plan → Implementation → Test → Review`.
- [ ] Require each stage to declare inputs, output artifacts, acceptance criteria, owner, and evidence.
- [ ] Persist artifact metadata and content hashes; keep large content in files, not JSONL event rows.
- [ ] Resume a pipeline from the last verified stage without rerunning completed mutations.

**Work package B — Scoped knowledge:**

- [ ] Ingest repository files and Markdown first; store source path, content hash, updated time, and scope.
- [ ] Implement deterministic path/keyword retrieval before semantic retrieval.
- [ ] Package retrieved items with source locations and a fixed context budget.
- [ ] Add semantic/vector retrieval only if it improves top-5 relevance by at least 15 percentage points on the fixed retrieval benchmark.
- [ ] Save only reviewed project decisions and verified artifacts as durable project memory.

**Exit gate:**

- [ ] Five real repository tasks finish through the standard pipeline.
- [ ] Every pipeline result links requirements, changed files, test output, and review evidence.
- [ ] Interrupted execution resumes without duplicating completed side effects.
- [ ] Retrieval benchmark reports precision@5 and source coverage.
- [ ] No retrieved item crosses its declared workspace/project scope.

**Stop line:** Do not start Level 4 product work if stage acceptance is subjective-only, durable memory can contain unverified Agent claims, or retrieval sources cannot be cited.

### Release 4.0 — Trajectory and Evaluation

Create the detailed Level 4 plan only after Release 3.0 passes.

**Deliverables:**

- [ ] Define a versioned trajectory projection assembled from Level 2/3 events.
- [ ] Add rule, test, static-analysis, human-feedback, and optional LLM-judge evaluators behind one `evaluate(run, evaluator)` boundary.
- [ ] Version evaluator configuration and store raw evidence separately from derived scores.
- [ ] Establish fixed orchestration, coding, and retrieval benchmark suites.
- [ ] Extend the existing dashboard with success, failure class, cost, latency, Agent, workflow, and evaluator-version filters.
- [ ] Add export/import for a redacted benchmark run.

**Storage decision gate:** Keep Workbench read-model projections in JSONL unless either a benchmark contains 100,000 projected events or dashboard query p95 exceeds 200 ms. Measure p95 over 30 cold-process repetitions of the versioned dashboard query fixture and record CPU, RAM, disk type, OS, Node version, event count, and query version. When either threshold is reached, implement the projection-facing `StateStore` interface with SQLite; DevFlow EventStore remains the governed source of truth and is not replaced by this optimization.

**Exit gate:**

- [ ] Re-evaluating the same immutable run with the same evaluator version produces the same deterministic scores.
- [ ] LLM-judge scores are reported separately and never override failed tests or security checks.
- [ ] The system can answer Agent/workflow success rate, cost, latency, and failure distribution for the fixed suite.
- [ ] At least 50 representative task cases have frozen baseline results.

**Stop line:** Do not start automatic candidate generation if deterministic evaluators disagree with stored raw evidence, benchmark tasks drift without a version change, or fewer than 50 representative task cases have frozen baseline results.

### Release 5.0 — Controlled Internal Evolution

Create the detailed Level 5 plan only after Release 4.0 passes.

**Deliverables:**

- [ ] Rank reflection candidates using difficulty, uncertainty, business value, and repeated-failure signals.
- [ ] Compare best/worst trajectories only within the same versioned task class.
- [ ] Produce structured candidate rules with scope, rationale, evidence links, expected effect, and rollback target.
- [ ] Benchmark candidates offline against the frozen baseline.
- [ ] Require human approval for promotion in the first release.
- [ ] Canary approved candidates on at most 10% of eligible runs and auto-disable on regression.

**Promotion rule:** Compare candidate and baseline on the same paired task set. Promote only when the candidate improves the primary success metric by at least 5 percentage points, the 95% bootstrap confidence interval for paired improvement excludes zero, no security/correctness regression occurs, and cost/latency stay within the pre-registered budget. Otherwise reject it and retain the experiment record.

**Exit gate:**

- [ ] Candidate history explains who/what proposed, evaluated, approved, promoted, rejected, and rolled back each version.
- [ ] Rollback restores the previous routing/workflow/meta-skill version without deleting history.
- [ ] A seeded bad candidate is rejected by regression tests.
- [ ] A canary threshold breach disables the candidate automatically.

### Release 6.0 — Technology Intelligence

Create the detailed Level 6 plan only after Release 5.0 passes. This is an independent ingestion pipeline; it cannot modify production behavior.

**Deliverables:**

- [ ] Ingest Papers, official documentation, official repositories, releases, and benchmarks with immutable source URLs and retrieval timestamps.
- [ ] Normalize each source into problem, method, evidence, limitations, applicable capability, and provenance.
- [ ] Rank Tier 1/2 evidence above discovery-only Tier 3/4 sources.
- [ ] Deduplicate sources by canonical URL, content hash, DOI, or repository identity.
- [ ] Record source license/terms, retrieval permission, retention class, and deletion status before storing full content; otherwise store metadata and a link only.
- [ ] Generate Candidate Patterns that can enter Level 7 experiments but cannot enter production directly.

**Exit gate:**

- [ ] A source can be traced from Candidate Pattern back to exact paper/repository/release evidence.
- [ ] Secondary sources alone cannot create an experiment-eligible candidate.
- [ ] Reprocessing unchanged sources is idempotent.
- [ ] Changed sources create a new version while preserving the old extraction.

### Release 7.0 — Evidence Graph, Experiment Lab, and Packages

Create the detailed Level 7 plan only after Release 6.0 passes.

**Work package A — Evidence graph:**

- [ ] Materialize nodes and edges from existing structured records; do not create a second source of truth.
- [ ] Support the initial queries: pattern provenance, implementation coverage, experiment evidence, and capability ownership.
- [ ] Keep EXTRACTED, INFERRED, and AMBIGUOUS relationship provenance distinct.
- [ ] Add a graph database only when the reference graph exceeds 100,000 edges or required path queries exceed 500 ms p95. Measure the versioned path-query fixture over 30 cold-process repetitions and record the same reference-machine profile used by the storage gate.

**Work package B — Experiment lab:**

- [ ] Run candidates in isolated worktrees/sandboxes after the Repository gate passes.
- [ ] Compare candidate and baseline on the same frozen task/evaluator versions.
- [ ] Persist environment, inputs, outputs, evidence, scores, cost, and decision.
- [ ] Route successful experiments back through the Level 5 approval/canary path.

**Work package C — Package ecosystem:**

- [ ] Extend the existing Package model only for assets proven by L2–L7: Agent, Skill, MCP, Workflow, Knowledge Pack, Meta-Skill, Evaluator, and Workspace Template.
- [ ] Require manifest, version, source, checksum, permissions, compatibility, and uninstall/rollback information.
- [ ] Install from local path or Git first; defer hosted Marketplace services until external publishers exist.
- [ ] Verify packages in a sandbox before making them available to a workspace.

**Exit gate:**

- [ ] Every production rule is traceable to trajectory, benchmark, experiment, or approved external evidence.
- [ ] Graph queries return source locations and provenance class.
- [ ] Package installation is reproducible and reversible.
- [ ] A malicious/invalid package fixture is rejected before execution.

## 4. Cross-Level Workstreams

### Security and privacy

- Treat prompts, retrieved context, tool arguments, files, and model output as potentially sensitive.
- Redact before persistence, not only before display.
- Store permissions and approval results with every side-effecting tool call.
- Add deletion/retention policy before ingesting user documents at Level 3.

### Evaluation integrity

- Keep raw evidence immutable.
- Never collapse test, security, human, and LLM-judge results into one unexplained score.
- Compare only runs with compatible task, environment, workflow, and evaluator versions.
- Freeze benchmark fixtures before using them for promotion decisions.

### Compatibility

- Preserve the existing CLI and manifest behavior unless a versioned migration is provided.
- New optional manifest fields must have safe defaults.
- Old trajectories remain readable after schema changes through projection/migration code.

## 5. Execution Cadence

For each release:

1. Write the level-specific implementation plan with exact files, interfaces, failing tests, commands, and commits.
2. Apply the staged gate: execute Tasks 1–6 after Repository readiness; execute Tasks 7–12 only after Repository, Provider, and Runtime readiness. Work one task at a time in an isolated worktree.
3. Review behavior against the spec after every task; run focused tests and then `npm test`.
4. Run the phase acceptance suite twice from clean temporary workspaces.
5. Record test output, benchmark output, changed files, known limitations, and the go/no-go decision.
6. Merge only after the exit gate passes; otherwise revise the same level rather than starting the next one.

## 6. Program Definition of Done

Level 7 is complete only when a real user task can be planned, routed, executed, verified, evaluated, compared with a candidate improvement, linked to internal/external evidence, promoted through approval/canary, and rolled back while preserving a complete redacted audit trail.

## 7. Deliberate Deferrals

- No ML-based router until rule routing has enough labeled outcomes to benchmark it.
- No vector database until deterministic retrieval loses the fixed benchmark.
- No graph database until path-query volume or latency crosses the stated gate.
- No hosted Marketplace until at least one external publisher and package trust workflow exist.
- No fully autonomous production evolution; human approval remains until a later policy explicitly removes it.
