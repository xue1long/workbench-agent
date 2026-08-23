# Level 7 Evidence Graph + Experiment Lab + Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind internal experience (trajectory/evaluation/candidate), external technology (intelligence sources/patterns) and packages into one traceable graph; prove the loop works end-to-end with an Experiment Lab; extend the package model so the proven assets are installable, verifiable, and reversible.

**Architecture:** `core/intelligence/graph.mjs` materializes a deterministic in-memory evidence graph from existing structured records (trajectory, evaluation, candidate, intelligence sources/patterns, knowledge index, packages). Edges carry `EXTRACTED | INFERRED | AMBIGUOUS` provenance. The graph backend stays in-memory until a measured threshold (`edges > 100,000` OR `path-query p95 > 500ms`) is reached, at which point a persistent backend is introduced — the Level 4 storage gate is the precedent. `core/laboratory/experiment.mjs` runs candidates in an isolated worktree against the frozen baseline (Level 5) and records environment/inputs/outputs/evidence/decision. Successful experiments return to the Level 5 approval/canary path. `core/packages-l7.mjs` extends the existing Package registry with 8 proven-asset kinds (Agent, Skill, MCP, Workflow, Knowledge Pack, Meta-Skill, Evaluator, Workspace Template) and enforces manifest, version, source, checksum, permissions, compatibility, uninstall/rollback — plus sandbox verification before a package becomes visible to a workspace.

**Tech Stack:** Node.js 20+ ESM, built-in `node:test`, existing JSONL `StateStore`, existing change-sandbox; no new dependency. The experiment sandbox reuses `createChangeSandbox` from Level 2; the package sandbox runs an install + verifier script in a temporary worktree.

**Spec:** `C:\Users\HP\OneDrive\007 - 个人笔记\000 Inbox\2026-08-23 Agent Workbench — Level 2 至 Level 7 实施方案.md` (Level 7) and `docs/superpowers/plans/2026-08-23-agent-workbench-level-2-to-7-execution.md` Release 7.0.

## Global Constraints

- The graph is a read-model projection of existing structured records; nothing here becomes a second source of truth.
- EXTRACTED, INFERRED and AMBIGUOUS relationships keep their provenance class; downstream queries can filter by class.
- Every production rule traces to trajectory / benchmark / approved external evidence or an approved experiment.
- Packages only come from local paths or git in this release; hosted marketplaces stay deferred.
- Sandbox verification gates every install; an unverifiable or malicious package fixture is rejected before any code from it can run.
- No new npm dependency, no database, no graph database unless the gate thresholds are reached.
- Every task begins with a failing test and ends with `npm test` passing (474 baseline).

---

## Phase 0: Execution readiness

- [ ] Run `npm test` in the worktree; expected: 474 tests, zero failures.
- [ ] Create isolated worktree `workbench-l7` from main; record baseline in `docs/level-7-acceptance.md`.

---

### Task 1: Evidence graph

**Files:**
- Create: `core/intelligence/graph.mjs`
- Create: `tests/intelligence-graph.test.mjs`

**Interfaces:**
- Produces: `EvidenceGraphError`.
- Produces: `buildGraph({ store }) -> Graph` — reads trajectory, evaluation, candidate/pattern, intelligence sources, knowledge rows, package rows and emits a deterministic in-memory graph of `{ nodes: [{id, kind, attrs}], edges: [{from, to, kind, provenance}] }`.
- Produces: `queryNodes({ graph, kind, filter })` and `queryEdges({ graph, kind, provenance })` — deterministic filters.
- Produces: `path({ graph, fromId, toId }) -> Edge[][]` — BFS/DFS path; provenance class preserved.
- Produces: `neighborsOf({ graph, id, maxDepth = 3 }) -> { nodes, edges }` — bounded traversal with provenance-class accounting.
- Provenance classes: `EXTRACTED` (direct mapping from a row field), `INFERRED` (derived, e.g. `candidate has evaluation reference`), `AMBIGUOUS` (multiple possible links, low confidence).
- Storage gate harness: measure path-query p95 over 30 cold-process repetitions against a 10k-edge fixture; JSONL stays unless thresholds reached.

- [ ] **Step 1: Write failing tests** (build from rows; queryNodes/Edges; path; neighbors; provenance classes; malicious fixture rejected)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/intelligence/graph.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add evidence graph with three provenance classes`

### Task 2: Experiment Lab

**Files:**
- Create: `core/laboratory/experiment.mjs`
- Create: `tests/laboratory-experiment.test.mjs`

**Interfaces:**
- Produces: `ExperimentError`.
- Produces: `runExperiment({ store, candidate, baselineCases, env, evaluatorVersion, runCase }) -> ExperimentRecord` — runs in an isolated worktree (`createChangeSandbox`), compares candidate vs baseline on the frozen task/evaluator versions, persists: `{ id, candidateId, env, inputs, outputs, evidenceRefs, scores, cost, decision, startedAt, finishedAt, sandboxPath }`.
- Produces: `experimentHistory({ store, candidateId })` and `decisionFromResult(result) -> 'promote'|'reject'`.
- Produces: `routeToCanary({ store, candidateId, canaryApi })` — when an experiment is `promote`, the candidate is offered to the existing Level 5 approval/canary boundary (the lab does NOT auto-promote).
- Sandbox runs only after the Repository gate; packages fetched only from local/git.

- [ ] **Step 1: Write failing tests** (experiment record shape; isolated sandbox; deterministic comparison; routeToCanary on promote; never auto-promote)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/laboratory/experiment.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add experiment lab with sandbox and canary routing`

### Task 3: Package ecosystem (8 kinds + sandbox verification)

**Files:**
- Create: `core/packages-l7.mjs`
- Create: `tests/packages-l7.test.mjs`

**Interfaces:**
- Produces: `PackageEcosystemError`.
- Produces: `PACKAGE_KINDS = ['agent', 'skill', 'mcp', 'workflow', 'knowledge-pack', 'meta-skill', 'evaluator', 'workspace-template']` (extends the M-series package set with `meta-skill`, `evaluator`, `workspace-template`).
- Produces: `registerPackage({ store, package: { id, kind, version, source, checksum, permissions, compatibility, uninstall, rollback } })` — manifest validated; rejects missing fields and unknown kinds.
- Produces: `verifyPackage({ store, packageId, sandbox }) -> Verification` — sandboxed install + verifier (writes to a temporary worktree, runs the verifier script, asserts exit 0 and verifies checksums).
- Produces: `installPackage({ store, packageId, workspaceRoot, sandbox })` — only callable after `verifyPackage` succeeded; writes to `.workbench/installed/<packageId>` with the manifest + checksum; supports `uninstallPackage` for rollback.
- Produces: `availablePackages({ store, kind })` — packages that passed sandbox verification.

- [ ] **Step 1: Write failing tests** (manifest validation; sandbox verifies a real package; sandbox rejects a malicious fixture; install is reproducible; uninstall restores prior state)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/packages-l7.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add package ecosystem with sandbox verification`

### Task 4: Level 7 acceptance fixtures and phase gate

**Files:**
- Create: `tests/level7_e2e.test.mjs`
- Create: `docs/level-7-acceptance.md`

**Acceptance fixtures:**
- Production rule traces through graph → trajectory → benchmark → frozen baseline (or trajectory → intelligence source/pattern) — EXTRACTED edges for the direct mappings.
- Graph queries return source locations and provenance class.
- Experiment Lab records env/inputs/outputs/evidence; sandbox respected; successful experiments route to canary (never auto-promote).
- Package installation reproducible + reversible; malicious package fixture rejected.
- A bad experiment (4pp worse) never promotes; successful experiment routes to the Level 5 boundary.

**Exit gate:**
- [ ] Every production rule is traceable to trajectory / benchmark / approved external evidence.
- [ ] Graph queries return source locations and provenance class.
- [ ] Package installation is reproducible and reversible.
- [ ] A malicious/invalid package fixture is rejected before execution.
- [ ] Full suite (`npm test`) passes twice.

**Stop line:** Do not mark Level 7 done if a production rule lacks evidence, a graph query returns no provenance, or a package is exposed without sandbox verification.

---

## Level 7 Definition of Done

- [ ] Evidence graph materializes from existing records with three provenance classes; queries return source locations.
- [ ] Experiment Lab runs candidates in isolated sandboxes and routes results to the Level 5 boundary.
- [ ] Package ecosystem enforces manifest, source, checksum, sandbox verification, install, uninstall.
- [ ] Every production rule is traceable to evidence.
- [ ] Exit gate and stop line satisfied; suite passes twice.

## Deliberate Deferrals

- Hosted Marketplace until at least one external publisher and package-trust workflow exist.
- Persistent graph backend until the Level 4 storage gate thresholds (≥100k edges OR path p95 > 500 ms) are measured to be exceeded.
- Auto-promotion from the lab remains explicit; the lab only routes successful experiments to the Level 5 approval boundary.
