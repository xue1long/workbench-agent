# Level 4 Trajectory + Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the system know what it did and how well it did it. Level 3 runs (pipeline + orchestration) become versioned trajectory records; one `evaluate(run, evaluator)` boundary produces versioned, deterministic scores with raw evidence stored separately; fixed benchmark suites freeze ≥50 representative task baselines; the dashboard answers success rate, cost, latency, and failure distribution questions; benchmark runs can be exported/imported in redacted form.

**Architecture:** `core/trajectory.mjs` assembles a versioned read-model projection from Level 2/3 run reports (append-only JSONL rows; no second source of truth — DevFlow EventStore remains authoritative for governed facts). `core/evaluation.mjs` defines the `evaluate(run, evaluator)` boundary: each evaluator declares `id`, `version`, `kind` (rule | test | static-analysis | human-feedback | llm-judge) and a deterministic function. Raw evidence rows and derived score rows are separate tables so scores can never silently detach from their evidence. LLM-judge scores are reported in their own field and can never override failed tests or security checks. Benchmark suites freeze fixtures; the frozen baseline is ≥50 representative task cases with recorded scores.

**Tech Stack:** Node.js 20+ ESM, built-in `node:test`, existing JSONL `StateStore`, existing L2/L3 core modules; no new npm dependency, no database (JSONL stays unless the storage decision gate measures a need).

**Spec:** `C:\Users\HP\OneDrive\007 - 个人笔记\000 Inbox\2026-08-23 Agent Workbench — Level 2 至 Level 7 实施方案.md` (Level 4) and `docs/superpowers/plans/2026-08-23-agent-workbench-level-2-to-7-execution.md` Release 4.0.

## Global Constraints

- Trajectory and evaluation projections are append-only, versioned, and rebuildable; they never authorize mutation or completion.
- Raw evidence is immutable; derived scores are stored in separate rows referencing the evidence rows that produced them.
- `evaluate(run, evaluator)` is the single boundary. Evaluators are pure/deterministic code; the only exception is `llm-judge`, whose output is reported separately and never overrides test/security outcomes.
- Evaluator configuration is versioned; re-evaluating the same immutable run with the same evaluator version must reproduce identical scores.
- Compare only runs with compatible task, workflow, environment, and evaluator versions.
- Benchmark fixtures freeze before any promotion decision; drift requires a version change.
- No database/queue/vector store unless the storage decision gate measures 100k projected events or dashboard query p95 > 200 ms (measured over 30 cold-process repetitions, recorded with the machine profile).
- Existing CLI, manifest, and dashboard behavior stays compatible; additions are additive.
- Every task begins with a failing test and ends with `npm test` passing (378 baseline).

---

## Phase 0: Execution readiness

- [ ] Run `npm test` in the worktree; expected: 378 tests, zero failures.
- [ ] Create isolated worktree `workbench-l4` from main; record baseline in `docs/level-4-acceptance.md`.

---

### Task 1: Versioned trajectory projection

**Files:**
- Create: `core/trajectory.mjs`
- Create: `tests/trajectory.test.mjs`

**Interfaces:**
- Produces: `TrajectoryError`.
- Produces: `recordRun({ run, projectionVersion = '1.0.0' }) -> TrajectoryRow` — normalizes a Level 2/3 run report (orchestrator report or pipeline report) into a row: `{ runId, taskId, workflowId (pipelineId or 'task'), templateVersion, executionStatus, finalStatus, failureClass, agentIds, cost, latencyMs, startedAt, finishedAt, artifactHashes, evidenceRefs, projectionVersion }`.
- Produces: `queryTrajectory({ rows, agent, workflow, status, failureClass, minCost, maxCost, maxLatencyMs }) -> TrajectoryRow[]` — deterministic filter (the same query the dashboard uses).
- Produces: `trajectorySummary(rows) -> { total, successRate, avgCostUsd, avgLatencyMs, failureDistribution, byAgent, byWorkflow }`.
- Failure class derivation is deterministic: `failed-dependency`, `budget`, `deadline`, `no-candidate`, `approval`, `stage-failed`, `quarantined`, `evaluator-reject` or `none`.

- [ ] **Step 1: Write failing tests** (normalization of pipeline report + orchestrator report; failureClass mapping; filters; summary aggregates; versioned rows)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/trajectory.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add versioned trajectory projection`

### Task 2: The `evaluate(run, evaluator)` boundary

**Files:**
- Create: `core/evaluation.mjs`
- Create: `tests/evaluation.test.mjs`

**Interfaces:**
- Produces: `EvaluationError`.
- Produces: `defineEvaluator({ id, version, kind, fn }) -> Evaluator` (frozen; kind ∈ rule|test|static-analysis|human-feedback|llm-judge).
- Produces: `evaluate({ run, evaluator, store, evidenceRefs }) -> EvaluationResult`:
  ```js
  { runId, evaluator: { id, version, kind }, scores: { ... }, rawEvidence: [refs], deterministic: true, evaluatedAt }
  ```
- Raw evidence rows are appended to store table `evaluation_raw` (`{ runId, evaluatorId, evaluatorVersion, evidenceKind, contentHash, byteCount, payloadRef }`); derived score rows to `evaluation_score` (`{ runId, evaluatorId, evaluatorVersion, scores, deterministic, evidenceIds }`). Scores never live inside raw rows and vice versa.
- `evaluate` is deterministic for a given (run, evaluator, evidence): same inputs → identical result (asserted).

- [ ] **Step 1: Write failing tests** (boundary shape; frozen evaluator; kind validation; raw vs score separation; determinism; version mismatch rejection when rerunning with a different evaluator version)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/evaluation.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add evaluate boundary with versioned evaluators`

### Task 3: Evaluator implementations

**Files:**
- Create: `core/evaluators.mjs`
- Create: `tests/evaluators.test.mjs`

**Interfaces:**
- Produces: `ruleEvaluator({ id, version, rules })` — thresholds on `executionStatus`, `finalStatus`, `cost`, `latencyMs`; deterministic boolean/score per rule.
- Produces: `testEvaluator({ id, version })` — reads pipeline test evidence claims (`kind === 'test'`) + test-report artifact content; score = passed/required; a failing required test forces `overall = 'fail'`.
- Produces: `staticAnalysisEvaluator({ id, version })` — deterministic checks over artifact content (e.g. TODO/FIXME count, trailing whitespace, byte limits); returns per-check scores.
- Produces: `humanFeedbackEvaluator({ id, version, scores })` — explicit human scores stored with provenance (`actor`).
- Produces: `llmJudgeEvaluator({ id, version, judge = null })` — if no judge is supplied, returns `{ overall: null, note: 'judge not configured', separate: true }`; when a judge is supplied (deterministic stub in tests), results are reported in `llmJudge` field on the evaluation result and can never set `overall` to pass if test/security checks failed.
- The evaluation result exposes `overall` derived ONLY from deterministic evaluators; llm-judge scores live in a separate `llmJudge` field.

- [ ] **Step 1: Write failing tests** (each evaluator; judge separation: failed test + judge-pass → overall stays fail; determinism)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/evaluators.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add rule, test, static-analysis, human-feedback and llm-judge evaluators`

### Task 4: Fixed benchmark suites and frozen baselines

**Files:**
- Create: `fixtures/evaluation/tasks.json` — 50 representative task cases (orchestration DAG cases, coding pipeline cases, retrieval queries) each with `{ id, suite, kind, input }`.
- Create: `core/benchmark-suites.mjs`
- Create: `tests/benchmark-suites.test.mjs`

**Interfaces:**
- Produces: `taskCaseCatalog() -> TaskCase[]` (frozen, ≥50 cases; suites: `orchestration`, `coding`, `retrieval`).
- Produces: `freezeBaseline({ rows })` — runs each task case through the corresponding deterministic path (orchestrator/pipeline doubles) and records trajectory + evaluation rows as the frozen baseline; the baseline manifest is `{ frozenAt, suite, caseCount, evaluatorVersions, scoreSnapshot }`.
- Produces: `baselineSummary(baseline) -> { caseCount, successRate, avgCost, avgLatency, bySuite }`.
- Re-running the same case catalog yields identical baselines (determinism gate).

- [ ] **Step 1: Write failing tests** (catalog ≥50 cases; suites complete; freeze produces ≥50 scored rows; deterministic across two freezes; summary)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement catalog + freeze**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: freeze 50-case benchmark baselines`

### Task 5: Dashboard evaluation filters

**Files:**
- Modify: `apps/web/server.mjs`
- Modify: `apps/web/app.js`
- Modify: `tests/web.test.mjs`

**Behavior:**
- New endpoint `GET /api/evaluation` with query params `agent`, `workflow`, `status`, `failureClass`, `evaluatorVersion`, `minCost`, `maxCost`, `maxLatencyMs` — runs `queryTrajectory` + `trajectorySummary` over the store projections and returns `{ summary, rows }`.
- Dashboard gains a filters bar and a runs table (success, failure class, cost, latency, agent, workflow, evaluator version); no framework, vanilla DOM.
- The dashboard query is the versioned fixture used by the storage decision gate.

- [ ] **Step 1: Write failing tests** (endpoint filters; summary; app.js renders a runs table; unknown filter values rejected)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement endpoint + app.js**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add evaluation filters to the dashboard`

### Task 6: Redacted benchmark exchange + storage decision gate

**Files:**
- Create: `core/benchmark-exchange.mjs`
- Create: `tests/benchmark-exchange.test.mjs`
- Create: `tests/storage-gate.test.mjs`

**Interfaces:**
- Produces: `exportBenchmarkRun({ rows, scoreRows, includeRaw = false }) -> { format: 'workbench-benchmark-1', exportedAt, benchmark: {...}, redacted: true }` — rows are redacted: no prompt/context/content fields, only hashes/paths/scores.
- Produces: `importBenchmarkRun(payload) -> { rows, scoreRows, validation }` — rejects non-redacted payloads (content present) and unknown format versions.
- Storage decision gate: a fixture with N trajectory rows (e.g. 1,000) and the versioned dashboard query; measure p95 wall time over 30 cold-process repetitions (`node --input-type=module -e ...` spawning the query) and record CPU/RAM/disk type/OS/Node version/event count/query version in `docs/level-4-acceptance.md`. If N reaches 100,000 or p95 > 200 ms → implement `StateStore` SQLite backend (otherwise JSONL stays; record the deferral).

- [ ] **Step 1: Write failing tests** (export redacts content; import rejects unredacted; round trip; gate harness runs and reports a p95 number)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement exchange + gate harness**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add redacted benchmark exchange and storage gate harness`

### Task 7: Level 4 acceptance fixtures and phase gate

**Files:**
- Create: `tests/evaluation_e2e.test.mjs`
- Create: `docs/level-4-acceptance.md`

**Acceptance fixtures:**
- Re-evaluate the same immutable run with the same evaluator version → identical scores (asserted twice).
- LLM-judge scores appear in a separate field and never override a failed test/security check.
- The system answers success rate, cost, latency, and failure distribution for the fixed suite (50 cases).
- Export/import of a redacted benchmark run round-trips.
- Dashboard query p95 recorded with the machine profile.

**Exit gate:**
- [ ] Re-evaluating the same immutable run with the same evaluator version produces the same deterministic scores.
- [ ] LLM-judge scores are reported separately and never override failed tests or security checks.
- [ ] The system can answer Agent/workflow success rate, cost, latency, and failure distribution for the fixed suite.
- [ ] At least 50 representative task cases have frozen baseline results.
- [ ] Full suite (`npm test`) passes twice.

**Stop line:** Do not start automatic candidate generation if deterministic evaluators disagree with stored raw evidence, benchmark tasks drift without a version change, or fewer than 50 representative task cases have frozen baseline results.

---

## Level 4 Definition of Done

- [ ] Versioned trajectory projection assembled from Level 2/3 events; append-only and rebuildable.
- [ ] `evaluate(run, evaluator)` boundary with versioned evaluators; raw evidence and derived scores in separate rows.
- [ ] rule / test / static-analysis / human-feedback / llm-judge evaluators; judge results separate and non-overriding.
- [ ] Fixed orchestration, coding, and retrieval suites; ≥50 frozen baseline cases.
- [ ] Dashboard filters: success, failure class, cost, latency, Agent, workflow, evaluator version.
- [ ] Redacted benchmark export/import; storage decision gate measured and recorded (JSONL deferred or SQLite implemented per the numbers).
- [ ] Exit gate and stop line satisfied; suite passes twice.

## Deliberate Deferrals

- SQLite StateStore until the storage gate measures ≥100,000 projected events or query p95 > 200 ms.
- Any ML/learned evaluator weighting until the deterministic baseline is stable.
- A live LLM judge service — the interface ships with a deterministic stub; wiring a real model is opt-in.
