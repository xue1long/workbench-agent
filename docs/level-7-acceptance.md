# Level 7 Acceptance Summary

> Working record for Agent Workbench Level 7 (Evidence Graph + Experiment Lab + Packages). All numbers come from the Workbench npm test suite run from the `workbench-l7` worktree.

## Gate Status (Phase 0)

| Gate | Status | Evidence |
| --- | --- | --- |
| Workbench baseline | PASS | `npm test` 474/474 in `D:\5-Project\20260823\workbench-l7` |
| Worktree | PASS | branch `workbench-l7` at `6eaee7c` (main) |
| Level 6 exit gate | PASS | `docs/level-6-acceptance.md`; merged `10f03b7` |

## Test Counts

- Workbench baseline (Level 6): 474/474
- Workbench after Level 7 Tasks 1-4: (record when complete)

## Commits

- (record per task)

## Level 7 Definition of Done

- [ ] Evidence graph with EXTRACTED/INFERRED/AMBIGUOUS; queries return sources.
- [ ] Experiment Lab in isolated sandbox; routes successful results to Level 5 boundary; never auto-promotes.
- [ ] Package ecosystem enforces manifest/source/checksum/sandbox/install/uninstall.
- [ ] Every production rule is traceable to evidence.
- [ ] Exit gate and stop line satisfied; suite passes twice.
