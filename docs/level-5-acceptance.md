# Level 5 Acceptance Summary

> Recorded for Agent Workbench Level 5 (Controlled Internal Evolution) on 2026-08-23, branch `workbench-l5`. All numbers come from the Workbench npm test suite run from the `workbench-l5` worktree.

## Gate Status

| Gate | Status | Evidence |
| --- | --- | --- |
| Workbench baseline | PASS | `npm test` 414/414 before Level 5 tasks |
| Level 4 exit gate | PASS | `docs/level-4-acceptance.md`; merged `d75fe65` |
| Level 5 full suite | PASS | 447/447 (second full pass: 447/447) |
| E2E acceptance | PASS | 4/4 in `tests/evolution_e2e.test.mjs` |

## Test Counts

- Workbench baseline (Level 4): 414/414
- Workbench after Level 5 Tasks 1-6: **447/447** (second full pass: 447/447)
- DevFlow Runtime pytest (unchanged): 338/338

## Commits (workbench-l5, oldest → newest)

1. `cb25017` feat: rank reflection candidates by deterministic signals
2. `016e61d` feat: compare best and worst trajectories within a task class
3. `68e5a5d` feat: add structured candidate lifecycle
4. `0b35d97` feat: benchmark candidates offline with paired bootstrap
5. `5896305` feat: enforce approval, canary and rollback
6. `(pending)` test: establish level 5 acceptance gate

## Acceptance Fixtures

- **Full lifecycle (promote path)** — propose (reflection-engine) → evaluated (benchmark) → benchmark 70%→100% (20 paired cases, bootstrap CI excludes zero, decision `promote`) → approved (human `alice`) → promoted → 30-run canary (≤10% slice, all green) → no breach, candidate stays promoted. History: `proposed → evaluated → approved → promoted` with actors and evidence refs.
- **Reject path** — a seeded bad candidate (80% → 60%, −20pp) is rejected by `promotionDecision`; lifecycle `proposed → evaluated → rejected`; nothing promoted.
- **Rollback** — restores `previousVersion: routing-default` (the recorded rollback target), history remains complete (`… → promoted → rolled-back` with `rollback:human`), nothing deleted.
- **Canary breach** — 6 results at 33% vs baseline 90% → breach detected; `autoDisable` transitions to `rolled-back` (`canary:regression-breach`) automatically; candidate no longer promoted.

## Trust Boundary Checklist

- Candidates only exist with evidence links (`proposeCandidate` rejects empty evidence); raw Agent claims cannot become candidates.
- Comparisons happen only within the same versioned task class (`taskClassOf` = workflowId:templateVersion).
- Promotion requires an explicit human approval record (`CANARY_APPROVAL_REQUIRED` otherwise).
- Canary slice ≤ 10% via deterministic hash of (candidateId, runId).
- Rollback appends history; nothing is deleted.
- The promotion rule is enforced verbatim: ≥5pp improvement AND bootstrap 95% CI excluding zero AND no security/correctness regression AND budget ok.

## Level 5 Definition of Done

- [x] Reflection candidates ranked by difficulty, uncertainty, business value, and repeated-failure signals.
- [x] Best/worst trajectory comparison within the same versioned task class.
- [x] Structured candidate rules with scope, rationale, evidence links, expected effect, rollback target; append-only lifecycle history.
- [x] Offline candidate benchmark against the frozen baseline with paired bootstrap 95% CI (deterministic, seeded).
- [x] Human approval required for promotion; ≤10% canary; auto-disable on regression; rollback without history deletion.
- [x] Exit gate and stop line satisfied; suite passes twice (447/447).

## Stop Line Review (Level 5 → Level 6)

- Candidates cannot exist without trajectory/evaluation evidence — `proposeCandidate` requires `evidenceLinks` — PASS.
- Comparisons never cross task classes — `bestWorstTrajectories` filters by exact `taskClassOf` — PASS.
- Promotion cannot happen without human approval — `promote` requires an `approved` history entry with a `human:` evidence ref — PASS.

## Known Limits

- Bootstrap CI assumes at least ~20 paired cases for stable tails (tests use 20; the frozen baseline has 50).
- Auto-promotion remains deliberately deferred; human approval is mandatory in this release.
