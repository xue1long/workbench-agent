# Level 4 Acceptance Summary

> Working record for Agent Workbench Level 4 (Trajectory + Evaluation). All numbers come from the Workbench npm test suite run from the `workbench-l4` worktree.

## Gate Status (Phase 0)

| Gate | Status | Evidence |
| --- | --- | --- |
| Workbench baseline | PASS | `npm test` 378/378 in `D:\5-Project\20260823\workbench-l4` |
| Worktree | PASS | branch `workbench-l4` at `1860633` (main) |
| Level 3 exit gate | PASS | `docs/level-3-acceptance.md`; merged `2026998` |

## Test Counts

- Workbench baseline (Level 3): 378/378
- Workbench after Level 4 Tasks 1-7: (record when complete)

## Storage Decision Gate

- (measured in Task 6; record event count, p95 over 30 cold-process repetitions, CPU/RAM/disk/OS/Node version, query version)

## Commits

- (record per task)

## Level 4 Definition of Done

- [ ] Versioned trajectory projection; append-only and rebuildable.
- [ ] `evaluate(run, evaluator)` boundary; raw evidence and derived scores separate.
- [ ] rule/test/static-analysis/human-feedback/llm-judge evaluators; judge separate and non-overriding.
- [ ] Fixed orchestration/coding/retrieval suites; ≥50 frozen baseline cases.
- [ ] Dashboard filters: success, failure class, cost, latency, Agent, workflow, evaluator version.
- [ ] Redacted benchmark export/import; storage gate measured.
- [ ] Exit gate and stop line satisfied; suite passes twice.
