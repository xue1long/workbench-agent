# Level 3 Acceptance Summary

> Working record for Agent Workbench Level 3 (Development Pipeline + Scoped Knowledge).
> All numbers below come from the Workbench npm test suite run from the `workbench-l3` worktree.

## Gate Status (Phase 0)

| Gate | Status | Evidence |
| --- | --- | --- |
| Workbench baseline | PASS | `npm test` 303/303 in `D:\5-Project\20260823\workbench-l3` |
| Worktree | PASS | branch `workbench-l3` at `f4b8002` (main); `git status --short` clean |
| Level 2 exit gate | PASS | recorded in `docs/level-2-acceptance.md`; Runtime 338/338 |

## Test Counts

- Workbench npm test baseline (Level 2): 303/303
- Workbench npm test after Level 3 Tasks 1-11: (record when complete)
- DevFlow Runtime pytest (unchanged by Level 3): 338/338

## Commits

- (record per task as implemented)

## Acceptance Fixtures

- Five repository tasks through the standard pipeline (deterministic x4 + offline live-path x1 via `fixtures/live/oauth-demo`).
- Pipeline result linking: requirements → changed files → test output → review evidence.
- Interrupted execution resumes without duplicating completed side effects.
- Retrieval benchmark: precision@5 and source coverage (record numbers here).
- Scope boundary: `scope: 'src/'` queries never return items from other scopes.

## Level 3 Definition of Done

- [ ] Pipeline templates immutable/versioned/validated; compile into ordinary Level 2 DAG nodes.
- [ ] Standard template Requirement → Analysis → Plan → Implementation → Test → Review ships and runs.
- [ ] Every stage declares inputs, output artifacts, acceptance criteria, owner, evidence.
- [ ] Artifact content in files; JSONL rows carry metadata + hashes only.
- [ ] Resume reuses only hash-verified stages; no duplicated side effects.
- [ ] Knowledge ingestion with retention and append-only supersede semantics.
- [ ] Deterministic scoped retrieval with hard scope boundary and context budget.
- [ ] Benchmark reports precision@5 and source coverage; semantic retrieval deferred unless ≥15-point gain.
- [ ] Project memory stores only reviewed decisions and verifier-backed evidence.
- [ ] Exit gate and stop line satisfied; suite passes twice.
