# Changelog

All notable changes to the Agent Workbench Runtime are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (with `0.y.z` reserved for pre-stable releases where anything may change at any time).

## [Unreleased]

## [0.1.0] - 2026-08-23

### Added — Workspace Core (M1–M5)
- M1 + M2: declarative `workspace.json` / `workspace.yaml` manifest, observed/applied state, plan, apply, verify, sync, restore, rollback, init, status.
- M3: agents, MCP, projects, packages, secret references; built-in adapter registry; process agent + codex + claude-code + devflow-runtime + git + python + node + uv adapters.
- M4: JSONL StateStore, lockfile, snapshot, rollback; read-only dashboard at `apps/web/` exposing workspace health + plan preview.
- M5: bilingual (en / zh-CN) read-only dashboard.

### Added — Level 2: Capability Orchestration
- Validated task graph, validated workflow executor (sequential / bounded-parallel / fan-out / fan-in), deterministic capability router, retry / fallback / reviewer / replan.
- Live governed path through the DevFlow Runtime Python project (`devflow_runtime`) over a stable JSON/YAML protocol — `runtime.yaml` defaults to `enabled: false`.

### Added — Level 3: Development Pipeline + Scoped Knowledge
- Immutable, versioned pipeline templates; `definePipeline` + `compilePipeline` compile to ordinary L2 DAG nodes.
- `standard-development` template: `Requirement → Analysis → Plan → Implementation → Test → Review`.
- `core/pipeline-runner.mjs` with artifact persistence (content-addressed files + JSONL rows), deterministic hash-checked resume (only definitionHash + artifact hash match → skip; mismatch → rerun), fail-closed execution gate (failed stage ⇒ no Runtime action), full provenance `evidence`/`changedFiles`/`artifacts`.
- Knowledge ingestion with retention policy (`link-only` ⇒ metadata only, body requires license + terms + permission + non-link-only retention); deterministic scoped retrieval (`retrieve`) with hard scope boundary, fixed context budget, citation fields; retrieval benchmark (precision@5 + source coverage, deterministic fixture); durable project memory (reviewed decisions + verifier-versioned artifacts only).

### Added — Level 4: Trajectory + Evaluation
- `core/trajectory.mjs`: versioned, append-only trajectory projection with deterministic failure-class mapping (`stage-failed`, `failed-dependency`, `budget`, `deadline`, `quarantined`, `no-candidate`, `approval`); `queryTrajectory` with agent/workflow/status/failureClass/cost/latency filters; `trajectorySummary` aggregates success rate, average cost, average latency, failure distribution, byAgent, byWorkflow.
- `core/evaluation.mjs`: single `evaluate(run, evaluator)` boundary; versioned evaluator config; raw evidence rows (`evaluation_raw`) and derived score rows (`evaluation_score`) live in separate tables; `strictVersion` rejects re-evaluation with a different evaluator version.
- Five evaluators: `rule`, `test`, `static-analysis`, `human-feedback`, `llm-judge`; `combineEvaluations` derives `overall` from deterministic results only — an LLM-judge verdict never flips a failed test or security check.
- 50-case frozen benchmark suite (20 orchestration + 15 coding + 15 retrieval cases); score snapshot is sha256-pinned.
- Dashboard `/api/evaluation` exposes filters + summary; `apps/web/app.js` renders a filters bar + runs table.
- Redacted benchmark exchange (`workbench-benchmark-1` format); content / prompt / stdout / stderr are stripped on export and validated on import.
- Storage decision gate harness: at 1,000 trajectory events p95 = **8.98 ms** over 30 cold-process repetitions on the dev box — JSONL stays; SQLite remains deferred.

### Added — Level 5: Controlled Internal Evolution
- `core/reflection.mjs`: deterministic reflection-signal ranking (`difficulty`, `uncertainty`, `businessValue`, `repeatedFailure`) bucketed by versioned task class (`workflowId:templateVersion`).
- `core/contrast.mjs`: best / worst trajectory selection within the same task class; structured differences (agent choice, workflow version, context size, tools, retries, failure class, latency, cost).
- `core/candidates.mjs`: structured candidate rules (`routing` / `workflow` / `meta-skill`) with scope, rationale, evidence links, expected effect, rollback target; append-only `candidate_history`; `applyCandidateRule` returns a no-op unless the candidate is `promoted`.
- `core/candidate-benchmark.mjs`: paired deterministic bootstrap (seeded mulberry32, 95% CI); `promotionDecision` enforces the promotion rule verbatim: ≥ 5 percentage-point improvement AND 95% CI excludes zero AND no security/correctness regression AND cost/latency within the pre-registered budget.
- `core/canary.mjs`: `approve` requires a named human; `promote` requires an `approved` history row with a `human:` evidence ref; `canarySlice` selects at most 10% of eligible runs via a deterministic hash of (candidateId, runId); `autoDisable` rolls the candidate back on threshold breach; rollback appends a history row, nothing is deleted.

### Added — Level 6: Technology Intelligence
- `core/intelligence/sources.mjs`: immutable source URLs, retrieval timestamps, tier (1–4), license / terms / retention class / permission; full content stored only when permission is granted AND license + terms are recorded AND retention class permits body.
- `core/intelligence/ingest.mjs`: idempotent, versioning ingestion with dedupe by canonical URL / DOI / repository identity; unchanged re-ingest returns `unchanged`; changed content creates a new version while preserving the old extraction.
- `core/intelligence/normalize.mjs`: structured normalization into `problem / method / evidence / limitations / applicableCapability / provenance`.
- `core/intelligence/patterns.mjs`: tier-ranked Candidate Patterns; only Tier 1 / 2 sources can produce an experiment-eligible pattern (`experimentEligible: true`); secondary sources alone can never promote.

### Added — Level 7: Evidence Graph + Experiment Lab + Packages
- `core/intelligence/graph.mjs`: deterministic in-memory evidence graph from trajectory, evaluation, candidate, intelligence source / extraction, knowledge, package rows; edges carry one of three provenance classes (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`); `queryEdges` filters by kind + provenance; `path` and `neighborsOf` bounded traversal; backend stays in-memory until the Level 4 storage gate measures a need for persistent storage.
- `core/laboratory/experiment.mjs`: isolated worktree run via `createChangeSandbox`; paired candidate vs baseline comparison on the frozen task / evaluator versions; records environment / inputs / outputs / evidenceRefs / scores / cost / decision; `routeToCanary` hands successful experiments to the Level 5 approval boundary — the lab never auto-promotes.
- `core/packages-l7.mjs`: 8 proven-asset kinds (`agent`, `skill`, `mcp`, `workflow`, `knowledge-pack`, `meta-skill`, `evaluator`, `workspace-template`); manifest, version, source (`local` / `git` only), sha256 checksum, permissions, compatibility, uninstall, rollback; sandbox verification gates every install; uninstall removes the directory AND reverses the verified flag so the package is no longer available until it re-passes verification.

### Engineering
- Zero runtime npm dependencies; the runtime relies only on Node 20+ built-ins.
- Bilingual (en / zh-CN) CLI + dashboard.
- Per-level `docs/level-{N}-acceptance.md` documents the gate status, fixture outcome, command list, and stop-line review.
- Detailed plans under `docs/superpowers/plans/2026-08-23-level-{2..7}-*.md` mirror the L2 plan structure (Global Constraints + Phase 0 + Tasks + Exit gate + Stop line + DoD + Deliberate Deferrals).

[Unreleased]: https://github.com/xue1long/workbench-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/xue1long/workbench-agent/releases/tag/v0.1.0
