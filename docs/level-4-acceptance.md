# Level 4 Acceptance Summary

> Recorded for Agent Workbench Level 4 (Trajectory + Evaluation) on 2026-08-23, branch `workbench-l4`. All numbers come from the Workbench npm test suite run from the `workbench-l4` worktree.

## Gate Status

| Gate | Status | Evidence |
| --- | --- | --- |
| Workbench baseline | PASS | `npm test` 378/378 before Level 4 tasks |
| Level 3 exit gate | PASS | `docs/level-3-acceptance.md`; merged `2026998` |
| Level 4 full suite | PASS | 414/414 (second full pass: 414/414) |
| E2E acceptance | PASS | 5/5 in `tests/evaluation_e2e.test.mjs` |

## Test Counts

- Workbench baseline (Level 3): 378/378
- Workbench after Level 4 Tasks 1-7: **414/414** (second full pass: 414/414)
- DevFlow Runtime pytest (unchanged): 338/338

## Storage Decision Gate (measured)

| Metric | Value |
| --- | --- |
| Event count | 1,000 trajectory rows |
| Query version | `dashboard-evaluation-1.0.0` |
| p95 over 30 cold-process repetitions | **8.98 ms** |
| Machine profile | Windows_NT 10.0.22631 · Intel i7-1065G7 1.30GHz (8 cores) · 15.7 GB RAM · SSD expected · Node v24.14.0 |

**Decision:** neither gate threshold is reached (1,000 « 100,000 projected events; p95 8.98 ms « 200 ms). The projection-facing `StateStore` stays JSONL; SQLite remains deferred. DevFlow EventStore remains the governed source of truth, untouched by this optimization.

## Commits (workbench-l4, oldest → newest)

1. `ddd39eb` docs: add level 4 acceptance stub
2. `20769c6` feat: add versioned trajectory projection
3. `d7217b1` feat: add evaluate boundary with versioned evaluators
4. `71743ba` feat: add rule, test, static-analysis, human-feedback and llm-judge evaluators
5. `d1e48da` feat: freeze 50-case benchmark baselines
6. `f41b30b` feat: add evaluation filters to the dashboard
7. `070af3a` feat: add redacted benchmark exchange and storage gate harness
8. `1dffc70` test: establish level 4 acceptance gate

## Acceptance Fixtures

- **Deterministic re-evaluation** — evaluating the same immutable run twice with the same evaluator version produces `deepEqual` identical results (rule evaluator asserted).
- **LLM-judge separation** — a judge verdict of "excellent" cannot flip a failed test to pass (`combineEvaluations` overall stays `fail`); judge output remains reported in `llmJudge`; a judge "fail" cannot override a deterministic pass.
- **50-case frozen baseline** — `taskCaseCatalog()` freezes exactly 50 representative cases (20 orchestration, 15 coding, 15 retrieval); `freezeBaseline()` records 50 trajectory rows + 100 evaluation score rows (rule + test per case); re-freezing reproduces an identical `scoreSnapshot` (sha256).
- **Fixed-suite answers** — with the frozen baseline persisted, `trajectorySummary` answers total, successRate, avgCostUsd, avgLatencyMs, failureDistribution, byAgent, byWorkflow; `queryTrajectory` filters by agent/workflow/status/failureClass/cost/latency.
- **Redacted exchange** — export/import round-trips a `workbench-benchmark-1` payload; content/prompt/stdout are stripped (set to null); import rejects non-redacted payloads and unknown formats.
- **Dashboard** — `/api/evaluation` returns `{ summary, rows, evaluators }`; filters for agent, workflow, status, failureClass, minCost, maxCost, maxLatencyMs, evaluatorVersion all asserted; dashboard UI gained a filters bar + runs table.
- **Storage gate** — measured and recorded (above); JSONL stays.

## Trust Boundary Checklist

- Trajectory/evaluation rows are append-only projections; they never authorize mutation or completion (DevFlow EventStore remains authoritative).
- Raw evidence rows (`evaluation_raw`) and derived score rows (`evaluation_score`) are separate tables; neither carries the other's fields.
- `strictVersion` rejects re-evaluating a run with a different evaluator version.
- LLM-judge output is `deterministic: false`, lives in `llmJudge`, and never sets `overall`.
- Benchmark exchange is redacted by construction and validated on import.

## Level 4 Definition of Done

- [x] Versioned trajectory projection assembled from Level 2/3 events; append-only and rebuildable.
- [x] `evaluate(run, evaluator)` boundary with versioned evaluators; raw evidence and derived scores separate.
- [x] rule / test / static-analysis / human-feedback / llm-judge evaluators; judge separate and non-overriding.
- [x] Fixed orchestration/coding/retrieval suites; 50 frozen baseline cases.
- [x] Dashboard filters: success, failure class, cost, latency, Agent, workflow, evaluator version.
- [x] Redacted benchmark export/import; storage gate measured (p95 8.98 ms @ 1k events — JSONL deferred).
- [x] Exit gate and stop line satisfied; suite passes twice (414/414).

## Stop Line Review (Level 4 → Level 5)

- Deterministic evaluators agree with stored raw evidence: scores are derived from persisted raw rows in the same evaluation call, and raw/score tables are linked by runId+evaluatorId+version — PASS.
- Benchmark tasks cannot drift without a version change: the catalog is frozen with `catalogVersion`, and the score snapshot is hash-pinned — PASS.
- ≥50 representative task cases have frozen baseline results: exactly 50 — PASS.

## Known Limits

- The llm-judge ships with a deterministic interface and stub; wiring a real model service is opt-in and out of the automated suite.
- The storage gate was measured at 1,000 events; re-measure before any large-scale ingestion.
