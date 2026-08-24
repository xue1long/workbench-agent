# Level-Boundary Acceptance Summary

> Recorded for Agent Workbench boundary enforcement on 2026-08-24, branch `workbench-boundary-l1`. All numbers come from the Workbench npm test suite run from the `workbench-boundary-l1` worktree.

## Gate Status

| Gate | Status | Evidence |
| --- | --- | --- |
| Workbench baseline | PASS | `npm test` 497/497 before any change (workbench-boundary-l1, main HEAD cea8d34) |
| Boundary violations at start | 13 | 4 files × concrete-adapter imports (sync/restore/status/projects) — see Task 4 for the breakdown |
| Boundary violations at end | 0 | `node scripts/check-boundaries.mjs` exits 0 across 64 files |
| Engineering gates (syntax/format/version) | PASS | `node scripts/check-syntax.mjs` (124 files ok), `node scripts/check-format.mjs` (120 files ok), `node scripts/check-version.mjs` (0.1.0 in CHANGELOG.md) green |
| Boundary contract gate | PASS | `node scripts/check-boundaries.mjs` green (0 violations) |
| Final `npm test` (clean checkout #1) | PASS | 515/515 in 60.4s |
| Final `npm test` (clean checkout #2) | PASS | 515/515 in 60.6s |

## Test Counts

- Workbench baseline (before): 497/497
- After Task 1 (boundary gate): 503/503 (6 new boundary tests)
- After Task 2 (registry): 511/511 (8 new registry tests)
- After Task 3 (adapters self-register): 515/515 (4 new adapters-index tests)
- After Task 4 (refactor core/*): 515/515 (no test count change, behavioural parity)
- After Task 5 (CI wiring): 515/515
- Final (clean checkout ×2): 515/515

## Tasks (commit log, oldest → newest)

1. `e2434c2` test(ci): add boundary contract gate and matrix-driven test
2. `5217aca` feat(core): add adapter registry to core/adapters.mjs
3. `4a89d95` feat(adapters): self-register through core/adapters.mjs registry
4. `0fd209b` refactor(core): look up adapters through core/adapters.mjs registry
5. `6ff43a2` chore(ci): run boundary contract gate in CI and local ci script
6. (this commit) docs(eng): record boundary enforcement gate and acceptance

## Trust Boundary Checklist

- [x] Boundary matrix in `scripts/check-boundaries.mjs` matches `docs/ENGINEERING.md` exactly
- [x] Concrete-adapter imports are detected by file path, not by symbol — `adapters/index.js` is the only allowed bulk import
- [x] `core/adapters.mjs` exposes `registerAdapter` / `getAdapter` / `listAdapters` / `_resetAdaptersForTests`
- [x] Adapter registry has exactly the 9 documented ids after `adapters/index.js` loads (claude-code, codex, devflow-runtime, git, node, process-agent, process-planner, python, uv)
- [x] Gate fails the build on any new violation
- [x] `npm test` passes twice from clean checkouts

## Definition of Done (mirrors plan)

- [x] `core/` → `adapters/` reverse imports: 4 files / 13 import statements → 0
- [x] Boundary gate runs in local `ci` and CI workflow
- [x] Adapter registry is the single allowed surface
- [x] Documentation reflects the gate (`docs/ENGINEERING.md` updated; this acceptance doc)
- [x] Full suite passes twice from clean checkouts (515/515)

## Stop Line

- [x] No file under `core/` still imports from `../adapters/*` (other than `adapters/index.js` for side-effect registration)
- [x] No `tests/` file imports a concrete adapter for its side effects
- [x] `npm test` did not regress (515/515 ≥ 497/497 baseline)
- [x] `docs/ENGINEERING.md` no longer claims the contract is enforced by `check-syntax` (it is enforced by `check:boundaries`)

## Scope expansion vs the original plan

The plan stated "4 violation sites" (4 files). Reality: those 4 files contained **13 distinct concrete-adapter import statements** that the gate flagged (sync: 4, restore: 5, status: 3, projects: 1). The plan's count was per-file, the gate counts per-import statement. All 13 imports were fixed in Task 4 by replacing `new ConcreteAdapter()` with `getAdapter(id)` — none required new module structure.

## Notes for future maintainers

- The `adapters-concrete` token in the matrix's `allow` list is **per-row**:
  - For `src/` it means "any concrete adapter file is OK" (CLI bootstrap)
  - For `core/` it means "only `adapters/index.js` is OK, not concrete files"
  Adding a new row? Read the matrix comment in `scripts/check-boundaries.mjs` first.
- Each `adapters/*.mjs` self-registers at module load. The `adapters/index.js` file is the bulk-import entry point that triggers all registrations; production code that needs `getAdapter()` must ensure `adapters/index.js` has been loaded (the four refactored core files each `import '../adapters/index.js'` for that side effect).
- `_resetAdaptersForTests()` exists in `core/adapters.mjs` for unit-test isolation, but the registration side-effect of `adapters/index.js` only runs **once per process** because ESM caches modules. Tests that need a clean registry should NOT use `_resetAdaptersForTests()` together with side-effect imports — the cached module will not re-register. This is intentional and documented in `tests/adapters-index.test.mjs`.

## Exit gate: PASS

All boxes above are checked. The branch is ready to merge.
