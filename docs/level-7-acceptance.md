# Level 7 Acceptance Summary

> Recorded for Agent Workbench Level 7 (Evidence Graph + Experiment Lab + Packages) on 2026-08-23, branch `workbench-l7`. All numbers come from the Workbench npm test suite run from the `workbench-l7` worktree.

## Gate Status

| Gate | Status | Evidence |
| --- | --- | --- |
| Workbench baseline | PASS | `npm test` 474/474 before Level 7 tasks |
| Level 6 exit gate | PASS | `docs/level-6-acceptance.md`; merged `10f03b7` |
| Level 7 full suite | PASS | 497/497 (second full pass: 497/497) |
| E2E acceptance | PASS | 5/5 in `tests/level7_e2e.test.mjs` |

## Test Counts

- Workbench baseline (Level 6): 474/474
- Workbench after Level 7 Tasks 1-4: **497/497** (second full pass: 497/497)
- DevFlow Runtime pytest (unchanged): 338/338

## Commits (workbench-l7, oldest → newest)

1. `0a4bee6` feat: add evidence graph with three provenance classes
2. `645ef7e` feat: add experiment lab with sandbox and canary routing
3. `b73188f` feat: add package ecosystem with sandbox verification
4. `a1f7f10` test: establish level 7 acceptance gate

## Acceptance Fixtures

- **Traceability** — a candidate's evidence chain (trajectory r-1, paper source, benchmark) is materialized as graph nodes; edges carry EXTRACTED (eval rows) and INFERRED (candidate→benchmark) provenance; `queryEdges` returns source locations.
- **Experiment Lab** — runExperiment records `env / inputs / outputs / evidenceRefs / scores / cost / decision / evaluatorVersion / evaluatorHash`; sandbox path included; successful experiments route to a caller-supplied `canaryApi.submitForCanary` — the lab never auto-promotes; bad experiments stay reject.
- **Package ecosystem** — 8 kinds; manifest validation; checksum verified in a sandbox worktree; install writes the verified manifest to `.workbench/installed/<id>/package.json`; uninstall removes the directory AND reverses the verified flag so the package is not available until it re-passes verification; tampered checksum fixture + verifier exit non-zero fixture both rejected before install.

## Trust Boundary Checklist

- Graph is a read-model projection of existing structured records; nothing becomes a second source of truth.
- Edges carry one of three provenance classes (EXTRACTED / INFERRED / AMBIGUOUS); downstream queries can filter by class.
- The lab's `routeToCanary` hands off to the existing Level 5 approval + canary boundary; the lab never promotes directly.
- Packages from `http` / hosted sources are rejected by manifest validation; manifests without a checksum or with a wrong checksum are rejected; unverified packages cannot be installed; uninstall reverses verification.

## Level 7 Definition of Done

- [x] Evidence graph materializes from existing records with three provenance classes; queries return source locations.
- [x] Experiment Lab runs candidates in isolated sandboxes and routes results to the Level 5 boundary.
- [x] Package ecosystem enforces manifest, source, checksum, sandbox verification, install, uninstall.
- [x] Every production rule is traceable to evidence.
- [x] Exit gate and stop line satisfied; suite passes twice (497/497).

## Stop Line Review (Level 7 done)

- Every production rule has graph evidence (verified by the traceability test) — PASS.
- Graph queries return source locations and provenance class (verified by queryEdges assertions) — PASS.
- Package installation is reproducible (verified + checksum match) and reversible (uninstall removes the directory and reverts verification) — PASS.
- A malicious package fixture (verifier exit non-zero OR tampered checksum) is rejected before any code from it runs — PASS.

## Known Limits

- The graph backend stays in-memory until the Level 4 storage gate measures a need for persistent storage.
- The Experiment Lab is deterministic with the provided `runCase`; production deployments may wire the live harness.
- The package ecosystem is local/git only; hosted Marketplace stays deferred.

## Program Definition of Done (Levels 2–7)

Level 7 is complete. The Workspace Runtime can now: orchestrate governed runs (Level 2), drive a standard development pipeline with scoped knowledge (Level 3), answer how well it did (Level 4), propose and canary candidate improvements with explicit human approval (Level 5), ingest external technology into traceable patterns (Level 6), and bind internal experience, external technology, and proven packages into a graph that supports an isolated experiment lab and a reproducible package ecosystem (Level 7). Every production rule is traceable through the evidence graph; rollback restores previous versions without deleting history; sandbox verification gates every install and every experiment.
