# Architecture Boundary Enforcement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the documented `core/` → `adapters/` reverse-dependency leaks (4 sites), introduce a single registration surface in `core/adapters.mjs`, and add a CI gate that fails the build when the contract breaks. Bring the implementation back into agreement with the boundary contract in `docs/ENGINEERING.md`.

**Architecture:** Add `registerAdapter({ id, factory })` / `getAdapter(id)` / `listAdapters()` to `core/adapters.mjs` alongside the existing `BaseAdapter` abstraction. The eight concrete adapter modules (`adapters/*.mjs`) gain a tiny side-effecting entry that registers themselves when `adapters/index.js` is imported. `core/sync.mjs`, `core/restore.mjs`, `core/status.mjs`, `core/projects.mjs` stop importing concrete adapter classes directly; they look them up by id through `getAdapter(id)`. A new gate script `scripts/check-boundaries.mjs` walks every file under `core/`, `apps/`, `src/`, `adapters/` and asserts the import-direction matrix declared in `ENGINEERING.md` §"The boundary contract". `package.json` gains a `check:boundaries` script and `ci` runs it before tests.

**Tech Stack:** Node.js 20+ ESM, Node built-in `node:fs`, `node:path`, the existing test runner, no new dependency. The new gate script follows the same shape as `scripts/check-syntax.mjs` / `scripts/check-format.mjs`.

**Spec:** `docs/ENGINEERING.md` §"The boundary contract" + the gap list in the architecture self-audit on 2026-08-24 (`docs/architecture-self-audit-2026-08-24.md`).

## Global Constraints

- The boundary contract in `docs/ENGINEERING.md` is the source of truth for allowed import directions; the gate enforces it exactly.
- `core/` MUST NOT `import '../adapters/*'` after this plan ships; the gate fails the build on any such import.
- `core/` MUST NOT grow new responsibilities; the registration surface lives in `core/adapters.mjs`, not a new file.
- `adapters/*` MUST register themselves through `registerAdapter({ id, factory })` exactly once at module load time.
- Every task begins with a failing test (the gate or a unit test) and ends with `npm test` green (497 baseline).
- No new npm dependency; no behavioural change to the orchestration logic — this is a refactor.
- Document the deferred gaps (2 and 6) explicitly so future Levels pick them up instead of forgetting.

---

## Phase 0: Execution readiness

- [ ] Run `npm test` in the worktree; expected: 497 tests, zero failures.
- [ ] Create isolated worktree `workbench-boundary-l1` from `main`; record baseline in `docs/level-boundary-acceptance.md` (new file).
- [ ] Run `git status --short`; record unrelated user changes and exclude them from implementation commits.

---

### Task 1: Boundary contract test (failing-first)

**Files:**
- Create: `scripts/check-boundaries.mjs`
- Create: `tests/boundaries.test.mjs`

**Interfaces:**
- `scripts/check-boundaries.mjs` exports nothing; prints violations to stdout and exits non-zero on any.
- The script walks every `*.mjs` and `*.js` under `core/`, `adapters/`, `apps/`, `src/` and applies this matrix:

  | From | May import | Forbidden |
  |---|---|---|
  | `src/` | `core/`, `adapters/`, `schemas/`, `apps/` | — |
  | `apps/` | `core/`, `schemas/` | `adapters/` (concrete classes only — abstract `core/adapters.mjs` is allowed) |
  | `adapters/` | `core/` | `apps/`, `src/` |
  | `core/` | (other `core/` only) | `adapters/`, `apps/`, `src/` |
  | `core/intelligence/` | `core/` (excluding `core/laboratory/`) | `core/laboratory/` |
  | `core/laboratory/` | `core/`, `core/intelligence/` | `apps/` |

- Concrete-adapter imports are detected by pattern `from\s+['\"][^'\"]*adapters/[a-z\-]+\.mjs['\"]` (anything under `adapters/` that is not `adapters/index.js`).
- The matrix and pattern live in the script as a single declarative table so future edits stay localised.
- `tests/boundaries.test.mjs` runs the script via `node:child_process.execFileSync` against a tmp directory that mirrors the real layout plus a synthetic `core/_bad.mjs` that imports `../adapters/git.mjs`; asserts exit-code 1 and that the violation is named in stderr.

- [ ] **Step 1: Write failing tests** (`tests/boundaries.test.mjs` covering the four current violation sites; the synthetic-failure case)
- [ ] **Step 2: Verify failure** — confirm the new tests fail (script does not yet exist, or the script does not yet catch all four sites)
- [ ] **Step 3: Implement `scripts/check-boundaries.mjs`** — matrix-driven, prints violations, exits non-zero
- [ ] **Step 4: Verify focused tests** — `node --test tests/boundaries.test.mjs` green
- [ ] **Step 5: Commit** `test(ci): add boundary contract gate and matrix-driven test`

### Task 2: Adapter registration surface in `core/adapters.mjs`

**Files:**
- Modify: `core/adapters.mjs`
- Create: `tests/adapter-registry.test.mjs`

**Interfaces:**
- `registerAdapter({ id, kind, factory })` — stores a factory keyed by `id`; rejects duplicate registration with `AdapterError('adapter already registered: <id>')`.
- `getAdapter(id, options = {})` — calls `factory(options)` and returns the adapter instance; throws `AdapterError('no adapter registered for: <id>')` if missing.
- `listAdapters()` — returns the sorted ids; the live registry after `adapters/index.js` loads has exactly the 8 ids documented in `package.json` keywords + `apps/web/server.mjs` references: `git`, `node`, `python`, `uv`, `codex`, `claude-code`, `devflow-runtime`, plus the two process adapters `process-agent`, `process-planner`.
- `_resetAdaptersForTests()` — exported for tests only; clears the registry. Tests must call it in `beforeEach`.
- `BaseAdapter` and `adapterResult` / `okResult` / `applyResult` / `planOne` / `REFUSE_ACTIONS` stay where they are.

- [ ] **Step 1: Write failing tests** (`tests/adapter-registry.test.mjs`: register, get, list, duplicate-rejection, unknown-id error, reset)
- [ ] **Step 2: Verify failure** — tests fail (registration surface missing)
- [ ] **Step 3: Implement** registration surface in `core/adapters.mjs`
- [ ] **Step 4: Verify focused tests** green
- [ ] **Step 5: Commit** `feat(core): add adapter registry to core/adapters.mjs`

### Task 3: Concrete adapters self-register

**Files:**
- Modify: `adapters/git.mjs`, `adapters/node.mjs`, `adapters/python.mjs`, `adapters/uv.mjs`, `adapters/codex.mjs`, `adapters/claude-code.mjs`, `adapters/devflow-runtime.mjs`, `adapters/process-agent.mjs`, `adapters/process-planner.mjs`
- Modify: `adapters/index.js`
- Create: `tests/adapters-index.test.mjs`

**Interfaces:**
- Each `adapters/*.mjs` gains a single bottom-of-file statement: `registerAdapter({ id: '<kind>', kind: 'tool', factory: (opts = {}) => new <ClassName>(opts) });`.
- `adapters/index.js` is the entry that imports all nine modules; `tests/adapters-index.test.mjs` imports `adapters/index.js`, then asserts `listAdapters()` returns the 8 ids (the process adapters share an id namespace but use distinct sub-ids `process-agent` and `process-planner`).
- Tests do not import the concrete adapter files directly; they only assert registration via `core/adapters.mjs`. This keeps the boundary test honest: if a future test starts `import`ing concrete adapters, the gate still passes — the registry is the only allowed surface.

- [ ] **Step 1: Write failing tests** (`tests/adapters-index.test.mjs`: after loading `adapters/index.js`, all 8 ids are present; `getAdapter('git')` returns a `GitAdapter` instance; `getAdapter('node')` returns a `NodeAdapter`; etc.)
- [ ] **Step 2: Verify failure** — tests fail (no `adapters/index.js` exists yet, or registration is missing)
- [ ] **Step 3: Implement** registration statements + `adapters/index.js`
- [ ] **Step 4: Verify focused tests** green
- [ ] **Step 5: Commit** `feat(adapters): self-register through core/adapters.mjs registry`

### Task 4: Refactor the four violating `core/` modules

**Files:**
- Modify: `core/sync.mjs`
- Modify: `core/restore.mjs`
- Modify: `core/status.mjs`
- Modify: `core/projects.mjs`

**Interfaces:**
- Each file's `defaultAdapterMap()` (or equivalent) becomes:
  ```js
  function defaultAdapterMap() {
    const map = new Map();
    for (const id of ['node', 'python', 'uv', /* + git for sync/projects */]) {
      map.set(id, getAdapter(id));
    }
    return map;
  }
  ```
- The `import` statements at the top change from `import { NodeAdapter } from '../adapters/node.mjs';` to nothing concrete; `core/sync.mjs` imports `getAdapter` from `core/adapters.mjs` (already a same-directory import).
- All four modules keep their existing public exports and observable behaviour; the only change is *how* the adapter instances are obtained.

- [ ] **Step 1: Write failing tests** — gate test (`tests/boundaries.test.mjs`) currently lists these four sites; once they are refactored, the synthetic-failure fixture is the only one that should trigger
- [ ] **Step 2: Verify failure** — run `node scripts/check-boundaries.mjs` and confirm it exits non-zero with the four violations named
- [ ] **Step 3: Refactor** the four files
- [ ] **Step 4: Verify focused and full suites** — `npm test` still 497 green; gate now passes with zero violations
- [ ] **Step 5: Commit** `refactor(core): look up adapters through core/adapters.mjs registry`

### Task 5: Wire gate into CI and local fast loop

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- `package.json` scripts gains:
  - `"check:boundaries": "node scripts/check-boundaries.mjs"`
  - `"verify": "node scripts/check-syntax.mjs && node scripts/check-format.mjs && node scripts/check-boundaries.mjs"` (extend, do not break)
  - `"ci": "node scripts/check-syntax.mjs && node scripts/check-boundaries.mjs && node --test tests/*.test.mjs"` (insert boundary check between syntax and tests)
- `.github/workflows/ci.yml` `engineering` job inserts a step `Boundary contract check` between `Format check` and `Version / CHANGELOG check`, calling `npm run check:boundaries`.

- [ ] **Step 1: Add the boundary check step to CI** — first run on `workbench-boundary-l1`, confirm CI green on push
- [ ] **Step 2: Update local fast loop** — `npm run ci` and `npm run verify` both call the gate
- [ ] **Step 3: Verify locally** — `npm run ci` exits 0; `npm run check:boundaries` exits 0
- [ ] **Step 4: Commit** `chore(ci): run boundary contract gate in CI and local ci script`

### Task 6: Documentation sync and acceptance fixture

**Files:**
- Modify: `docs/ENGINEERING.md`
- Create: `docs/level-boundary-acceptance.md`

**Interfaces:**
- `docs/ENGINEERING.md` §"What the engineering gates enforce" gains a row: `Boundary contract | npm run check:boundaries | core -> adapters reverse imports, intelligence <-> laboratory direction, adapters -> apps`.
- `docs/ENGINEERING.md` §"The boundary contract" gains an explicit note: "This contract is enforced by `scripts/check-boundaries.mjs` (matrix in §...) — added 2026-08-24 by `2026-08-24-architecture-boundary-enforcement` plan."
- `docs/level-boundary-acceptance.md` records: baseline (497 tests, 0 fail); four violation sites at start; zero violations at end; CI green on the gate step; `npm test` twice from clean checkouts.

- [ ] **Step 1: Update ENGINEERING.md** — gate row + enforcement note
- [ ] **Step 2: Write `docs/level-boundary-acceptance.md`** — gate status table, before/after counts, trust-boundary checklist
- [ ] **Step 3: Run `npm test` twice from clean checkouts** — both passes must be green (497/497)
- [ ] **Step 4: Commit** `docs(eng): record boundary enforcement gate and acceptance`

---

## Exit gate

- [ ] `scripts/check-boundaries.mjs` exists and exits 0 on the current `main` HEAD after refactor.
- [ ] `tests/boundaries.test.mjs` covers the four original violation sites and the synthetic-failure case.
- [ ] `core/adapters.mjs` exports `registerAdapter`, `getAdapter`, `listAdapters`, `_resetAdaptersForTests`.
- [ ] `adapters/index.js` is the only place that imports concrete adapter modules; the registry has the 8 documented ids.
- [ ] `core/sync.mjs`, `core/restore.mjs`, `core/status.mjs`, `core/projects.mjs` no longer import from `../adapters/*`.
- [ ] `npm run ci` runs the gate; `npm run check:boundaries` exits 0; `.github/workflows/ci.yml` runs the gate in the engineering job.
- [ ] `docs/ENGINEERING.md` and `docs/level-boundary-acceptance.md` describe the gate.
- [ ] Full suite (`npm test`) passes twice from clean checkouts.

## Stop line

Do not merge this branch if:
- Any file under `core/` still imports from `../adapters/*` (the gate fails — that is the stop).
- A `tests/` file imports a concrete adapter directly without going through `adapters/index.js` (the gate fails).
- `npm test` regresses (any test count drop).
- `docs/ENGINEERING.md` still claims the contract is enforced by `check-syntax` (it isn't; the boundary gate is the enforcement).

## Boundary Plan Definition of Done

- [ ] `core/` → `adapters/` reverse imports: 4 → 0
- [ ] Boundary gate runs in local `ci` and CI workflow
- [ ] Adapter registry is the single allowed surface; one `adapters/index.js` registers all eight concrete adapters
- [ ] Documentation in `ENGINEERING.md` and `level-boundary-acceptance.md` reflects the gate
- [ ] Full suite passes twice from clean checkouts (497/497)
- [ ] Architecture self-audit gap 1 (boundary contract) closed

---

## Deliberate Deferrals

- **Gap 2 — Trust-boundary semantics for `REFUSE_ACTIONS`.** `core/adapters.mjs` exposes `REFUSE_ACTIONS = { 'force-push', 'branch-delete', 'reset-hard', 'uninstall-managed' }` and the workspace runtime treats it as authoritative; the DevFlow Runtime sister project also runs its own scope verifier. The semantics of "Workbench preflight" vs "DevFlow authoritative check" are not formalised anywhere. Defer to a future Level-shaped plan that adds a contract test (`tests/trust-boundary.test.mjs`) asserting the two checks agree on the same input.
- **Gap 3 — Graph extraction noise from `schemas/`.** The `graphify` extraction of `schemas/workspace.schema.json` produces 334 dangling-endpoint edges because JSON-schema property names look like identifier references. Defer; this requires either a schema adapter in `graphify` or a post-extraction filter.
- **Gap 4 — Dashboard data-flow E2E.** `tests/web.test.mjs` covers the HTTP shape, not a real `pipeline run → /api/status` round-trip. Defer until a `tests/dashboard-data-flow.test.mjs` is written.
- **Gap 5 — L7 remote-package download E2E.** The package-ecosystem tests use local fixtures only. Defer; the network-rejection branch is unexercised.
- **Gap 6 — CLI docs / `--help` synchronisation.** README lists 16 commands; `--help` is the source of truth but is not gated against the README. Defer; cheap to add later.
- **Boundary matrix extensions.** The current matrix covers the four violating files. A future audit may extend it to forbid `core/X.mjs` from importing `core/Y.mjs` when X and Y are in unrelated subtrees (e.g. `core/agents.mjs` ↔ `core/intelligence/`). Defer until the audit shows a need.
- **Auto-discovered adapter tests.** Today every concrete adapter is hand-registered in `adapters/index.js`. A future plan could generate the registration from `adapters/index.js` discovery; not now.

---

## Files Created / Modified (summary)

| File | Action |
|---|---|
| `scripts/check-boundaries.mjs` | create |
| `tests/boundaries.test.mjs` | create |
| `core/adapters.mjs` | modify (add registry) |
| `adapters/git.mjs`, `adapters/node.mjs`, `adapters/python.mjs`, `adapters/uv.mjs`, `adapters/codex.mjs`, `adapters/claude-code.mjs`, `adapters/devflow-runtime.mjs`, `adapters/process-agent.mjs`, `adapters/process-planner.mjs` | modify (self-register) |
| `adapters/index.js` | create |
| `tests/adapter-registry.test.mjs` | create |
| `tests/adapters-index.test.mjs` | create |
| `core/sync.mjs`, `core/restore.mjs`, `core/status.mjs`, `core/projects.mjs` | modify (refactor imports) |
| `package.json` | modify (scripts) |
| `.github/workflows/ci.yml` | modify (gate step) |
| `docs/ENGINEERING.md` | modify (gate row + enforcement note) |
| `docs/level-boundary-acceptance.md` | create |
