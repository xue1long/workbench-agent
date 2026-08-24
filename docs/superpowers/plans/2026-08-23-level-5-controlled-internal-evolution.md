# Level 5 Controlled Internal Evolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the system learn from its own evaluated experience — but only through evidence. Reflection candidates are ranked by deterministic difficulty/uncertainty/business-value/repeated-failure signals, best/worst trajectories are compared only inside the same versioned task class, candidates are benchmarked offline against the Level 4 frozen baseline with a paired bootstrap CI, promotion requires explicit human approval, and promoted candidates run on a ≤10% canary with automatic rollback on regression — all history preserved.

**Architecture:** `core/reflection.mjs` ranks candidate topics from trajectory rows; `core/contrast.mjs` compares best/worst trajectories within one versioned task class and extracts structured differences; `core/candidates.mjs` owns the versioned candidate rule lifecycle (proposed → evaluated → approved → promoted → rejected → rolled-back) with an append-only history; `core/candidate-benchmark.mjs` runs the paired offline benchmark and applies the promotion rule (≥5pp improvement, bootstrap 95% CI excluding zero, no security/correctness regression, cost/latency within pre-registered budget); `core/canary.mjs` enforces the ≤10% canary slice and auto-disable on regression, with rollback restoring the previous routing/workflow/meta-skill version without deleting history.

**Tech Stack:** Node.js 20+ ESM, built-in`node:test`, existing JSONL `StateStore`, Level 4 trajectory/evaluation modules; no new dependency; bootstrap CI is a deterministic seeded re-sampling (no stats library).

**Spec:** `C:\Users\HP\OneDrive\007 - 个人笔记\000 Inbox\2026-08-23 Agent Workbench — Level 2 至 Level 7 实施方案.md` (Level 5) and `docs/superpowers/plans/2026-08-23-agent-workbench-level-2-to-7-execution.md` Release 5.0.

## Global Constraints

- Evaluation before evolution: no candidate exists without trajectory + evaluation evidence.
- Comparisons happen only within the same versioned task class (suite + kind + evaluator versions).
- Candidates are structured rules with scope, rationale, evidence links, expected effect, and rollback target; raw Agent claims are never candidates.
- Promotion requires human approval in this release; nothing auto-promotes.
- Canary slice is at most 10% of eligible runs; a regression breach disables the candidate automatically.
- Rollback restores the previous routing/workflow/meta-skill version without deleting any history row.
- All candidate lifecycle transitions are append-only records; no mutation of past records.
- Every task begins with a failing test and ends with`npm test` passing (414 baseline).

---

## Phase 0: Execution readiness

- [ ] Run`npm test` in the worktree; expected: 414 tests, zero failures.
- [ ] Create isolated worktree `workbench-l5` from main; record baseline in `docs/level-5-acceptance.md`.

---

### Task 1: Reflection signal ranking

**Files:**
- Create: `core/reflection.mjs`
- Create: `tests/reflection.test.mjs`

**Interfaces:**
- Produces: `rankReflectionCandidates({ rows, weights = { difficulty: 1, uncertainty: 1, businessValue: 1, repeatedFailure: 2 } }) -> CandidateTopic[]` — one topic per (taskClass, failureClass) bucket, scored deterministically:
  - difficulty: from task metadata (`difficulty` 0-1) or derived from cost/latency percentiles;
  - uncertainty: proportion of runs with null/ambiguous evidence or repeated retries;
  - businessValue: from task metadata (`businessValue` 0-1) or a declared map;
  - repeatedFailure: count of failures in the bucket (weighted).
- Produces: `taskClassOf(row) -> string` — stable `${workflowId}:${kind or templateVersion}`.
- Produces: `candidateTopicsSummary(topics)` — top-N by score with reasons.

- [ ] **Step 1: Write failing tests** (ranking order deterministic; repeated-failure signal dominates; weights change order; bucket stability; reasons list)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/reflection.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: rank reflection candidates by deterministic signals`

### Task 2: Contrastive trajectory comparison within a task class

**Files:**
- Create: `core/contrast.mjs`
- Create: `tests/contrast.test.mjs`

**Interfaces:**
- Produces: `bestWorstTrajectories({ rows, taskClass, scoreFn }) -> { best, worst, scoreFnVersion }` — best/worst by a caller-supplied deterministic score over the same task class; ties broken by runId.
- Produces: `contrast({ best, worst }) -> Difference[]` — structured differences: agent choice, workflow/template version, context size (estimatedContextTokens), tools, retries, failure class, latency, cost.
- Produces: `contrastSummary(differences) -> string[]` — human-readable bullet list used as candidate rationale material.

- [ ] **Step 1: Write failing tests** (selection within class only; scoreFn deterministic; tie-break; difference extraction; summary)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/contrast.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: compare best and worst trajectories within a task class`

### Task 3: Structured candidate rules with an append-only lifecycle

**Files:**
- Create: `core/candidates.mjs`
- Create: `tests/candidates.test.mjs`

**Interfaces:**
- Produces: `CandidateError`.
- Produces: `proposeCandidate({ id, version, scope, rationale, evidenceLinks, expectedEffect, rollbackTarget, store }) -> Candidate` — status `proposed`; the rule body is a versioned structured rule (e.g. routing weight change) that must validate against a schema: `{ kind: 'routing'|'workflow'|'meta-skill', params }`.
- Produces: `transitionCandidate({ store, candidateId, to, evidenceRef = null, actor = null }) -> CandidateRecord` — statuses: proposed → evaluated → approved → promoted; proposed → rejected; promoted → rolled-back; approved → rejected. Every transition appends a history row (`candidate_history`): `{ candidateId, from, to, evidenceRef, actor, at }`.
- Produces: `candidateHistory({ store, candidateId }) -> rows` and `activeCandidates({ store })`.
- Produces: `applyCandidateRule(candidate, context) -> result` — applies the versioned rule to routing/workflow selection (deterministic; used by the canary gate to decide whether a run gets the candidate).

- [ ] **Step 1: Write failing tests** (proposal validation; illegal transitions rejected; history append-only; active list; rule application)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/candidates.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add structured candidate lifecycle`

### Task 4: Offline candidate benchmark against the frozen baseline

**Files:**
- Create: `core/candidate-benchmark.mjs`
- Create: `tests/candidate-benchmark.test.mjs`

**Interfaces:**
- Produces: `runCandidateBenchmark({ baseline, candidate, evaluateCase, budget, seed = 42, bootstrapSamples = 1000 }) -> CandidateBenchmarkResult` — paired evaluation: for each task case in the same class, run baseline and candidate versions (caller supplies `evaluateCase(case, version)`); compute per-case success deltas; bootstrap 95% CI over the paired deltas with a deterministic PRNG (mulberry32 seeded); check: improvement ≥ 5pp, CI excludes 0, no security/correctness regression (candidate must not flip any security/correctness check from pass to fail), cost/latency within the pre-registered budget.
- Produces: `promotionDecision(result) -> { decision: 'promote'|'reject', reasons[] }` — implements the promotion rule verbatim.
- Produces: `recordBenchmark({ store, candidateId, result })` — appends the experiment record (`candidate_benchmark`).

- [ ] **Step 1: Write failing tests** (paired evaluation; CI excludes zero on a seeded improvement; 4pp improvement → reject; security regression → reject; budget breach → reject; determinism: same seed → same CI)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/candidate-benchmark.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- **Step 5: Commit** `feat: benchmark candidates offline with paired bootstrap`

### Task 5: Approval, canary and rollback

**Files:**
- Create: `core/canary.mjs`
- Create: `tests/canary.test.mjs`

**Interfaces:**
- Produces: `CanaryError`.
- Produces: `promote({ store, candidateId, actor })` — requires a prior `evaluated` transition AND an explicit human approval record; otherwise rejected.
- Produces: `canarySlice({ store, runId, maxFraction = 0.1 }) -> boolean` — deterministic: a candidate-eligible run (matching the candidate scope) is selected for canary with probability ≤ maxFraction via a seeded hash of runId; a selected run is recorded (`canary_run`).
- Produces: `reportCanaryResult({ store, candidateId, runId, success })` and `canaryStatus({ store, candidateId })` — tracks windows; when the regression threshold (e.g. success rate below baseline − 10pp over a minimum window of runs) is breached, the candidate is auto-disabled (transition to `rolled-back`) and the previous version is restored.
- Produces: `rollback({ store, candidateId, actor })` — restores the previous routing/workflow/meta-skill version reference without deleting history.

- [ ] **Step 1: Write failing tests** (promotion requires approval; slice ≤ 10% and deterministic; auto-disable on threshold breach; rollback restores previous version; history intact after rollback)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/canary.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: enforce approval, canary and rollback`

### Task 6: Level 5 acceptance fixtures and phase gate

**Files:**
- Create: `tests/evolution_e2e.test.mjs`
- Create: `docs/level-5-acceptance.md`

**Acceptance fixtures:**
- Candidate history explains who/what proposed, evaluated, approved, promoted, rejected, and rolled back each version.
- Rollback restores the previous routing/workflow/meta-skill version without deleting history.
- A seeded bad candidate (4pp worse) is rejected by the promotion decision.
- A canary threshold breach disables the candidate automatically and restores the previous version.
- Full lifecycle walkthrough: propose → evaluate → benchmark (pass) → approve → promote → canary → success → stay; and propose → evaluate → benchmark (fail) → reject.

**Exit gate:**
- [ ] Candidate history explains who/what proposed, evaluated, approved, promoted, rejected, and rolled back each version.
- [ ] Rollback restores the previous routing/workflow/meta-skill version without deleting history.
- [ ] A seeded bad candidate is rejected by regression tests.
- [ ] A canary threshold breach disables the candidate automatically.
- [ ] Full suite (`npm test`) passes twice.

**Stop line:** Do not start Level 6 product work if candidates can exist without trajectory/evaluation evidence, comparisons cross task classes, or promotion can happen without human approval.

---

## Level 5 Definition of Done

- [ ] Reflection candidates ranked by difficulty, uncertainty, business value, and repeated-failure signals.
- [ ] Best/worst trajectory comparison within the same versioned task class.
- [ ] Structured candidate rules with scope, rationale, evidence links, expected effect, rollback target; append-only lifecycle history.
- [ ] Offline candidate benchmark against the frozen baseline with paired bootstrap 95% CI.
- [ ] Human approval required for promotion; ≤10% canary; auto-disable on regression; rollback without history deletion.
- [ ] Exit gate and stop line satisfied; suite passes twice.

## Deliberate Deferrals

- Multi-agent debate / voting on candidates — single deterministic pipeline first.
- Automatic promotion without human approval — explicitly deferred to a later policy.
- Learned difficulty/uncertainty estimators — deterministic signals until labeled outcomes exist.
