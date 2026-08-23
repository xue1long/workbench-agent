# Level 3 Development Pipeline + Scoped Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Level 2 orchestration layer into a standard development pipeline whose stages run as ordinary Level 2 DAG nodes, and add a deterministic, scope-bounded knowledge layer so agents work from long-term project knowledge instead of only one-shot context.

**Architecture:** Pipeline templates are immutable, validated descriptions of stages; `compilePipeline` turns them into ordinary Level 2 `TaskGraph` nodes so all Level 2 trust boundaries (routing, sandbox, Runtime Action Gateway, trusted Evidence, `finish` Decision) apply unchanged. Artifact content lives in files under `.workbench/pipelines/<pipelineId>/artifacts/`; JSONL rows persist only metadata plus sha256 digests. Knowledge ingestion stores content-addressed files under `.workbench/knowledge/objects/` with an append-only JSONL index; retrieval is deterministic path/keyword scoring with a hard scope boundary and a fixed context budget. Durable project memory accepts only reviewed decisions and verifier-backed evidence, never raw `EvidenceClaim`s.

**Tech Stack:** Node.js 20+ ESM, built-in `node:test`, existing JSONL `StateStore`, existing `executeWorkflow`/`Orchestrator` boundaries; no new Node runtime dependency, no vector store, no database. The Runtime path (when live) reuses the Level 2 `DevflowRuntimeAdapter` through the extracted `Orchestrator.runGraph`.

**Spec:** `C:\Users\HP\OneDrive\007 - 个人笔记\000 Inbox\2026-08-23 Agent Workbench — Level 2 至 Level 7 实施方案.md` (Level 3 section) and `docs/superpowers/plans/2026-08-23-agent-workbench-level-2-to-7-execution.md` Release 3.0.

## Global Constraints

- All Level 2 trust boundaries remain: Agent output is `EvidenceClaim`; only Runtime/Verifier output with provenance and `verifier_version` is trusted Evidence; only a valid EventStore `finish` Decision maps to final completion; environment/config mutations stay on Apply outside governed sessions.
- Pipeline templates are immutable and versioned. Stages are composed of ordinary Level 2 DAG nodes — no second execution engine.
- Every stage must declare inputs, output artifacts, acceptance criteria, owner, and evidence. A stage with missing or subjective-only acceptance fails validation; acceptance kinds reuse the Level 2 verifier set (`test`, `scope`, `diff`, `architecture`, `audit`, `budget`, `dependency`). The Review stage itself compiles to node `kind: 'review'`, which the Level 2 workflow executor already understands.
- Resume reuses only stages whose definitionHash AND persisted artifact hashes match; completed mutations are never re-applied. Reuse is decided by programmatic hash comparison, not by LLM.
- Artifact content is never stored in JSONL event rows — only path, sha256, byteCount, kind, scope, and produced-by metadata. Large content lives in files.
- Knowledge index is append-only; corrections are new records that supersede old ones. Deletion/retention exists before any user document is ingested.
- Retrieval is deterministic path/keyword first. Semantic/vector retrieval is added only if it improves top-5 relevance by at least 15 percentage points on the fixed benchmark — otherwise it stays a recorded deferral.
- Retrieval never crosses its declared scope: an item whose `scope` is outside the query scope is excluded programmatically, and the response cites exact source paths.
- Durable project memory stores only reviewed decisions and verified artifacts (verifier-versioned Evidence). Unverified Agent claims are rejected and never written to memory.
- No new npm dependency, no database, no vector store, no graph database, no frontend framework.
- Every implementation task begins with a failing test and ends with `npm test` passing (303 baseline).
- The live governed path (optional acceptance) requires the Repository, Provider, and Runtime gates that already passed in Level 2; runtime.yaml stays `enabled: false` by default.

---

## Phase 0: Execution readiness

Current observation: Level 2 passed its exit gate (303 Workbench tests, DevFlow Runtime 338/338, live CLI field acceptance on the real devflow-runtime process). Level 3 may start.

- [ ] Run `npm test` in the worktree; expected: 303 tests, zero failures.
- [ ] Record the worktree branch, baseline commit, Node version, and test count in `docs/level-3-acceptance.md`.
- [ ] Confirm `git status --short` in the worktree is clean before Task 1.
- [ ] Reuse `fixtures/live/oauth-demo` as the offline repository fixture for the five-task acceptance; no network or credentials required.

**Completion criterion:** clean worktree, green baseline suite, acceptance stub recorded. Unlocks Tasks 1–5 (deterministic) and later tasks.

---

### Task 1: Add the immutable pipeline template contract

**Files:**
- Create: `core/pipeline.mjs`
- Create: `tests/pipeline.test.mjs`

**Interfaces:**
- Produces: `PipelineError`.
- Produces: `definePipeline({ id, version, stages }) -> PipelineTemplate` (deep-frozen, versioned).
- Produces: `validatePipeline(template)` — internal; rejects on failure.
- Produces: `compilePipeline(template, task) -> TaskGraph` — one L2 node per stage; node `dependencies` derive from declared `inputs`; node carries `acceptanceCriteria`, `kind: 'work'|'review'`, and a `stage` metadata field (id/name/outputs/owner/evidence/scope).
- Produces: `pipelineTemplateVersion(template) -> string`.

Stage shape:

```js
{
  id: 'implementation', name: 'Implementation',
  inputs: ['plan'],                    // artifact refs from earlier stages (or 'requirement')
  outputs: ['implementation-artifact'],
  acceptance: [{ id: 'impl-tests', kind: 'test', required: true }],
  owner: 'implementation',             // capability or agent id
  evidence: [{ id: 'impl-evidence', kind: 'artifact', required: true }],
  scope: 'src/',                       // knowledge scope the stage may read/write
}
```

Task 1 covers: valid construction; deep-freeze (mutations throw in strict mode); duplicate stage ids; unknown input ref (must reference an earlier stage output or an externally-declared `input` of the template); missing owner; empty acceptance; acceptance referencing an unknown verifier kind; `compilePipeline` producing a TaskGraph with correct dependencies, acceptanceCriteria, and stage metadata; a template whose `version` is missing being rejected; and equal definitionHash for two templates with identical structure.

- [ ] **Step 1: Write failing contract tests** (`tests/pipeline.test.mjs`)
- [ ] **Step 2: Verify the tests fail** (`node --test tests/pipeline.test.mjs`)
- [ ] **Step 3: Implement `core/pipeline.mjs`** — pure validation + compile; reuse `createTaskGraph`/`canonicalJson` from `core/task-graph.mjs`
- [ ] **Step 4: Verify focused and full suites** (focused then `npm test`, 303 + new all green)
- [ ] **Step 5: Commit** `feat: add immutable pipeline template contract`

### Task 2: Ship the standard development pipeline template

**Files:**
- Create: `core/pipeline-templates.mjs`
- Create: `tests/pipeline-templates.test.mjs`

**Interfaces:**
- Produces: `standardDevelopmentPipeline() -> PipelineTemplate` with stages `Requirement → Analysis → Plan → Implementation → Test → Review` (ids: `requirement`, `analysis`, `plan`, `implementation`, `test`, `review`).
- Produces: `pipelineTemplates.list() -> [{ id, version, stageIds }]` and `pipelineTemplates.get('standard-development')`.

Every stage declares inputs (linking to the previous stage's output artifacts), one or more output artifacts, at least one acceptance criterion with a verifier kind, an owner, and evidence. `implementation` declares scope `src/` or the workspace root per fixture; `review` is `kind: 'review'` in the compiled graph. The template is immutable and versioned (`1.0.0`).

- [ ] **Step 1: Write failing tests** — template shape, stage count and order, per-stage declarations present, compiled graph has 6 nodes with chained dependencies and a review node.
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/pipeline-templates.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add standard development pipeline template`

### Task 3: Extract `runGraph` from the Orchestrator (backward compatible)

**Files:**
- Modify: `core/orchestrator.mjs`
- Modify: `tests/orchestrator.test.mjs`

**Interfaces:**
- Produces (new): `Orchestrator.runGraph(graph, task, options) -> runReport` — the body of today's `runTask` after planning: routing, sandboxed invocation, candidate collection, approval, Runtime submission, fail-closed mapping.
- Keeps: `Orchestrator.runTask(task, options)` — now `planTask` + `runGraph`.
- Produces (new, optional): `options.skipNode(node) -> { skip: true, output, evidenceClaims } | null` — lets a caller (pipeline resume) short-circuit a verified node without re-invoking the agent; default null.

Contract tests: existing 303 stay green; `runTask` results are byte-identical in shape; `runGraph` accepts a planner-produced graph; `skipNode` returning a stub result prevents the invoker from being called for that node and keeps the node's status SUCCEEDED; skipNode returning null runs normally.

- [ ] **Step 1: Write failing tests for `runGraph` and `skipNode`**
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Refactor `runTask` into `planTask` + `runGraph`; add `skipNode`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `refactor: extract runGraph and add resume skipNode`

### Task 4: Pipeline runner with artifact persistence and resume

**Files:**
- Create: `core/pipeline-runner.mjs`
- Create: `tests/pipeline-runner.test.mjs`

**Interfaces:**
- Produces: `PipelineRunnerError`.
- Produces: `createPipelineRunner({ orchestrator, store, artifactsRoot }) -> PipelineRunner`.
- Produces: `runner.run({ template, task, resumeRunId?, approveChangeSet? }) -> PipelineRunReport`.
- Produces: `runner.status({ pipelineId, runId }) -> StageStates`.

Artifact persistence: each stage node's result may carry `artifacts: [{ name, content, kind, scope }]`. The runner writes content to `artifactsRoot/<pipelineId>/<stageId>/<name>` and appends a metadata row (path, sha256, byteCount, kind, scope, producedBy stage, runId, supersedes refs) to store table `pipeline_artifact`. Node output is rewritten to carry artifact refs only.

Stage states: store table `pipeline_stage` rows per stage per run: `{ pipelineId, runId, stageId, definitionHash, status, artifactHashes, evidenceRefs, startedAt, finishedAt }`.

Resume: `runner.run({ resumeRunId })` reads the previous run's `pipeline_stage` rows; for each stage whose definitionHash matches AND whose artifact rows are still present with unchanged sha256, `skipNode` returns the stored output (no agent invocation, no mutation). A stage whose hash differs or whose artifact is missing re-runs. No duplicate file edits; interrupted runs resume from the last verified stage.

Report shape: `{ pipelineId, templateVersion, runId, resumedFrom, executionStatus, stages: {...}, artifacts: [refs], changedFiles: [...], evidence: [...], reviewDecision }`.

- [ ] **Step 1: Write failing tests** — artifact persisted to disk with metadata row; large content never appears in JSONL rows; run report links stages→artifacts→changedFiles→evidence; resume with matching hashes skips verified stages (invocation counter unchanged) and does not duplicate side effects; resume with changed definitionHash re-runs that stage; interrupted run (handler throws after stage N) resumes from stage N+1.
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/pipeline-runner.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: run pipelines with artifact persistence and resume`

### Task 5: Expose pipeline simulation and live execution through the CLI

**Files:**
- Modify: `src/workbench.mjs`
- Modify: `tests/cli.test.mjs`

**Interfaces:**
- `workbench pipeline list` — template id/version/stages.
- `workbench pipeline simulate --template standard-development --goal "..."` — compiled DAG + per-stage declarations, no execution.
- `workbench pipeline status --pipeline-id <id> --run-id <id>` — stage states.
- `workbench pipeline run --template standard-development --goal "..." [--resume-run <id>] [--approve-changes]` — live path mirroring `task run` (runtime.yaml `enabled: true` required for governed stages; deterministic handler otherwise), reusing the same approval and fail-closed logic.

- [ ] **Step 1: Write failing CLI tests**
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement the smallest CLI handlers**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: expose pipeline commands in the CLI`

### Task 6: Knowledge ingestion with retention policy

**Files:**
- Create: `core/knowledge-store.mjs`
- Create: `tests/knowledge-store.test.mjs`

**Interfaces:**
- Produces: `KnowledgeStoreError`.
- Produces: `createKnowledgeStore({ store, objectsRoot }) -> KnowledgeStore`.
- Produces: `ingest({ sourcePath, kind, scope, content }) -> IndexRow` — sha256 of content, content written to `objectsRoot/<sha256>` (deduplicated), index row appended to store table `knowledge_index`: `{ sourcePath, contentHash, byteCount, updatedAt, scope, kind, retention }`.
- Produces: `ingestDirectory({ dir, scope, kinds }) -> { ingested, skipped }` — walks repo files (`.md` first, then code by extension allowlist), records each.
- Produces: `removeIndexRow({ sourcePath })` and `purgeUnreferenced()` — retention: delete object file only when no index row references the hash; keeps append-only history by marking rows superseded instead of deleting them.
- Produces: `list({ scope })`.

Retention policy is enforced before ingestion completes for a user-specified scope; default retention `keep`, with `expire-after-days` supported in the row metadata.

- [ ] **Step 1: Write failing tests** — dedupe by hash; metadata row has no content field; append-only supersede semantics; purge only unreferenced objects; scope recorded; invalid scope rejected.
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/knowledge-store.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add knowledge ingestion with retention policy`

### Task 7: Deterministic scoped retrieval with a context budget

**Files:**
- Create: `core/knowledge-retrieval.mjs`
- Create: `tests/knowledge-retrieval.test.mjs`

**Interfaces:**
- Produces: `KnowledgeRetrievalError`.
- Produces: `retrieve({ index, query, scope, budgetChars = 8000 }) -> { items: [{ sourcePath, contentHash, scope, score, matchedTerms, excerpt }], budgetUsed, totalChars, scopeCapped }`.
- Scoring is deterministic: term overlap (weighted, terms normalized), path closeness (query path tokens vs item sourcePath), scope exact-match bonus. No ML, no embeddings.
- Scope boundary is hard: items whose `scope` is not within the query `scope` (path-prefix containment) are excluded before scoring, never returned.
- Context packaging: items are packed in score order until `budgetChars`; each item reports `charCount`; the response cites exact `sourcePath` and `contentHash` for every item.

- [ ] **Step 1: Write failing tests** — deterministic order given identical input; out-of-scope items never returned; budget respected; citations present; ties broken by sourcePath; excerpt contains matched keyword context.
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/knowledge-retrieval.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add deterministic scoped retrieval`

### Task 8: Fixed retrieval benchmark (precision@5 and source coverage)

**Files:**
- Create: `core/retrieval-benchmark.mjs`
- Create: `tests/retrieval-benchmark.test.mjs`
- Create: `fixtures/knowledge/benchmark/*` (documents + queries with gold ids)

**Interfaces:**
- Produces: `runRetrievalBenchmark({ index, benchmark }) -> { precisionAt5, sourceCoverage, perQuery: [...] }`.
- Benchmark fixture: ~10–20 Markdown/code documents across two scopes, 6–8 queries each with gold relevant item ids; `precision@5` = correct in top 5 / 5; `sourceCoverage` = fraction of gold items retrieved at least once across the suite.
- The baseline numbers are recorded in `docs/level-3-acceptance.md`. Semantic/vector retrieval stays deferred unless it beats deterministic precision@5 by ≥15 points — that decision is recorded, not implemented.

- [ ] **Step 1: Write failing tests** — benchmark runs, reports precision@5 and source coverage, per-query rows are stable across two runs.
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/retrieval-benchmark.mjs` + fixture**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add retrieval benchmark with precision and coverage`

### Task 9: Durable project memory (reviewed decisions and verified evidence only)

**Files:**
- Create: `core/project-memory.mjs`
- Create: `tests/project-memory.test.mjs`

**Interfaces:**
- Produces: `ProjectMemoryError`.
- Produces: `createProjectMemory({ store, objectsRoot }) -> ProjectMemory`.
- Produces: `saveDecision({ runId, decision })` — only `kind: 'decision'` with `reviewed: true` and a reviewer evidence ref may be stored; content to disk, metadata row to store table `project_memory`.
- Produces: `saveVerifiedArtifact({ runId, artifact })` — requires `artifact.verifierVersion` and `artifact.evidenceKind` in a trusted set (`test`, `rule`, `scope`, `diff`); raw `EvidenceClaim`s without a verifier are rejected.
- Produces: `query({ scope, kind })` — append-only reads with supersede handling.
- Produces: `memoryIndex({ scope })`.

- [ ] **Step 1: Write failing tests** — reviewed decision saved; unreviewed decision rejected; unverified claim rejected; verified artifact saved with provenance; superseded entries are append-only new rows; query by scope/kind.
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/project-memory.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add durable project memory for reviewed knowledge`

### Task 10: Wire scoped knowledge into pipeline stages and add CLI commands

**Files:**
- Modify: `core/pipeline-runner.mjs`
- Modify: `src/workbench.mjs`
- Modify: `tests/pipeline-runner.test.mjs`, `tests/cli.test.mjs`

**Behavior:**
- Stage nodes may declare `knowledge: { query, scope, budgetChars }`; the runner calls `retrieve` and attaches `{ knowledge: { items, budgetUsed, sources } }` to the node context passed to the invoker (deterministic fixtures assert the attachment and the scope boundary).
- CLI: `workbench knowledge ingest --dir <path> --scope <scope>`, `workbench knowledge retrieve --query "..." --scope <scope>`, `workbench knowledge benchmark`, `workbench memory list --scope <scope>`.

- [ ] **Step 1: Write failing tests** — stage context carries scoped knowledge items with citations; out-of-scope knowledge never reaches a stage; CLI commands return expected shapes.
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement wiring + CLI**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: wire scoped knowledge into pipeline stages`

### Task 11: Level 3 acceptance fixtures and phase gate

**Files:**
- Create: `tests/pipeline_e2e.test.mjs`
- Create: `tests/knowledge_e2e.test.mjs`
- Create: `docs/level-3-acceptance.md`

**Acceptance fixtures:**
- Five repository tasks finish through the standard pipeline: deterministic fixtures (temp repo + scripted handlers) for four, and one offline live-path run using `fixtures/live/oauth-demo` with `runtime.yaml enabled: true` (same bound as Level 2: ≤5 UTF-8 files, explicit approval required, only a valid Runtime `finish` maps to completion).
- Every pipeline result links requirements → changed files → test output → review evidence (assert the report's artifact/evidence/changedFiles references).
- Interrupted execution resumes without duplicating completed side effects (handler counter + file-content assertion).
- Retrieval benchmark reports precision@5 and source coverage; both numbers recorded.
- Scope boundary: a query with `scope: 'src/'` never returns items from `docs/` or another project scope.

**Exit gate:**
- [ ] Five real repository tasks finish through the standard pipeline.
- [ ] Every pipeline result links requirements, changed files, test output, and review evidence.
- [ ] Interrupted execution resumes without duplicating completed side effects.
- [ ] Retrieval benchmark reports precision@5 and source coverage.
- [ ] No retrieved item crosses its declared workspace/project scope.
- [ ] Full suite (`npm test`) passes twice from clean temporary workspaces.

**Stop line:** Do not start Level 4 product work if stage acceptance is subjective-only, durable memory can contain unverified Agent claims, or retrieval sources cannot be cited.

---

## Level 3 Definition of Done

- [ ] Pipeline templates are immutable, versioned, validated, and compile into ordinary Level 2 DAG nodes.
- [ ] The standard template (`Requirement → Analysis → Plan → Implementation → Test → Review`) ships and runs.
- [ ] Each stage declares inputs, output artifacts, acceptance criteria, owner, and evidence; acceptance always references a verifier.
- [ ] Artifact content lives in files; JSONL rows carry only metadata + hashes.
- [ ] Resume reuses only definitionHash- and artifact-hash-verified stages; completed side effects are never duplicated.
- [ ] Knowledge ingestion stores path/hash/time/scope with retention and append-only supersede semantics.
- [ ] Retrieval is deterministic, scope-hard-bound, budget-bounded, and cites source paths.
- [ ] The fixed retrieval benchmark reports precision@5 and source coverage; semantic retrieval remains a recorded deferral until it wins by ≥15 points.
- [ ] Durable project memory stores only reviewed decisions and verifier-backed evidence.
- [ ] Level 3 acceptance fixtures pass twice; `npm test` stays green; the exit gate and stop line are recorded in `docs/level-3-acceptance.md`.

## Deliberate Deferrals

- Semantic/vector retrieval until the fixed benchmark shows a ≥15-point top-5 improvement.
- PDF/Docs/Issue ingestion — Markdown and code first per the plan; PDF metadata is a later extension.
- A hosted knowledge service or shared store — local-first only.
- Any database/queue/vector store until the Level 4 storage gate measures a need.
