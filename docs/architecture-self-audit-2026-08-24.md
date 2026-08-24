# Architecture Self-Audit — 2026-08-24

> Honest assessment of where the Agent Workbench architecture actually stands, what
> was fixed on this date, what remains open, and where to find the audit trail.

**Date:** 2026-08-24
**Baseline:** `origin/main` @ `9009090 fix(format): strip extra trailing newline`
**Audit ran from:** `D:\5-Project\20260823\Workspace Runtime`
**Reviewer:** deepseek-harness agent via runtime governance (2 sessions)

---

## TL;DR

The basic core architecture is in good shape on the dimensions the project
chose to optimize for (determinism, reproducibility, governance, append-only
audit). One significant architectural contract was being violated at runtime
without enforcement — that is now fixed and gated. Five smaller gaps remain
open; the most valuable next work is closing three of them in a single short
plan.

| # | Gap | Status (2026-08-24) | Plan |
|---|---|---|---|
| 1 | `core/` → `adapters/` reverse dependencies | **CLOSED** | `2026-08-24-architecture-boundary-enforcement.md` |
| 2 | `REFUSE_ACTIONS` two-layer semantics | open | future Level-shaped plan |
| 3 | graphify schema noise (334 dangling edges) | open | graphify-side fix, defer |
| 4 | dashboard data-flow E2E test | open | `2026-08-24-cleanup-three-gaps.md` (proposed) |
| 5 | L7 remote-package download E2E | open | `2026-08-24-cleanup-three-gaps.md` (proposed) |
| 6 | CLI / `--help` documentation sync gate | open | `2026-08-24-cleanup-three-gaps.md` (proposed) |

---

## How this audit was produced

1. **Read everything.** `README.md`, `docs/ENGINEERING.md`, every `level-{2..7}-acceptance.md`, the `superpowers/plans/` set, the `core/`, `adapters/`, `apps/`, `src/`, `tests/` trees. Cross-checked against the L1–L7 numbers in the test suite (515 passing) and the dependency graph extracted via `graphify` (1,248 nodes, 2,460 edges, 70 communities).
2. **Found six gaps** that the project's own self-assessment documents don't surface. Three are real architectural contracts being violated; three are missing end-to-end tests.
3. **Wrote a superpowers-style plan** for the biggest one (gap 1): `docs/superpowers/plans/2026-08-24-architecture-boundary-enforcement.md`.
4. **Executed it task-by-task** on a worktree branch `workbench-boundary-l1`, merging into `main` after two clean `npm test` passes.
5. **Governed review via devflow-runtime.** Two `DevflowSession` reviews (`session-c1e82ef3781e` initial, `session-c6aa3eb0ba63` post-fix). The review caught one real defect: an extra trailing newline in `scripts/check-boundaries.mjs` that local `npm run ci` does not exercise (CI's full `npm run verify` did). Fixed in commit `9009090`.
6. **Pushed five CI runs** to `origin/main`, all green: Node 20/22/24 matrix + devflow-runtime pytest.

## Honest assessment (post-fix)

| Dimension | Score | Comment |
|---|---|---|
| Functional completeness (L1–L7) | 9/10 | All seven levels shipped, acceptance docs exist |
| Test coverage | 8.5/10 | 515 tests; dashboard data flow and remote-package download not exercised end-to-end |
| **Architecture boundary enforcement** | **9/10** | Was 6/10 yesterday; gate is in place and runs in CI |
| Trust-contract clarity | 7/10 | `REFUSE_ACTIONS` semantics split between Workbench and DevFlow Runtime, undocumented |
| Tooling / CI gates | 9/10 | Six gates; the two new ones (boundaries, devflow sister checkout) added in this audit |
| Reproducibility | 9.5/10 | Zero runtime deps, LF line endings, Conventional Commits, double `npm test` |
| Auditability | 8.5/10 | Evidence graph with three provenance classes; ~13% dangling edges from schema extraction noise |
| Deliberate deferrals handled | 9/10 | Each deferral has a documented reason (storage gate, semantic-retrieval gate, etc.) |
| **Weighted total** | **8.6/10** (was 8.2/10) | Net gain from gate closure offset by transparency about new-found gaps |

---

## Gap 1 — `core/` → `adapters/` reverse dependencies — CLOSED

### What was wrong
`docs/ENGINEERING.md` declares a boundary contract: `core/*` may import from
`core/*` only, and `adapters/*` may not import from `apps/`, `src/`, etc. Four
core modules bypassed this contract by directly instantiating concrete
adapter classes:

| File | Concrete-adapter imports |
|---|---|
| `core/sync.mjs` | `GitAdapter`, `NodeAdapter`, `PythonAdapter`, `UvAdapter` |
| `core/restore.mjs` | `NodeAdapter`, `PythonAdapter`, `UvAdapter`, `claudeCodeAdapter`, `CodexAdapter` |
| `core/status.mjs` | `NodeAdapter`, `PythonAdapter`, `UvAdapter` |
| `core/projects.mjs` | `GitAdapter` |

13 import statements total. `check-syntax` did not enforce the contract; it
only parsed files. Nothing else did.

### What was done
- **Registry surface**: `core/adapters.mjs` gained `registerAdapter({ id, kind, factory })`, `getAdapter(id, opts)`, `listAdapters()`, `_resetAdaptersForTests()`.
- **Self-registration**: each `adapters/*.mjs` calls `registerAdapter` at module load time.
- **Bulk-import entry point**: `adapters/index.js` re-exports every concrete class and triggers registration as a side effect of being imported.
- **Refactor**: the four core modules now import `{ getAdapter }` from `core/adapters.mjs` and call `getAdapter(id)` instead of `new ConcreteAdapter()`.
- **Gate**: `scripts/check-boundaries.mjs` walks every `*.mjs`/`*.js` under `src/`, `apps/`, `adapters/`, `core/`, `schemas/`. It applies a matrix declared at the top of the script — adding a new subtree means extending the matrix, not weakening the rules.
- **Matrix per-row semantics** (the part that took three iterations to get right):
  - `src/` row `allow: ['core', 'adapters', 'schemas', 'apps', 'adapters-concrete']` — CLI bootstrap is allowed to import any concrete adapter class.
  - `core/` row `allow: ['core', 'adapters-concrete']` — `adapters-concrete` means **only** `adapters/index.js`, not concrete adapter files. This is what enforces the contract.
  - `adapters/` row `allow: ['core', 'adapters']` — sibling helpers (e.g. `process-planner` borrowing `runProcess` from `process-agent`) are legitimate.
  - `adapters/X/index.{js,mjs}` is the only entry point allowed to bulk-import concrete adapters.

### Verification
- `node scripts/check-boundaries.mjs` before fix: **13 violations across 4 files**. After fix: **0 violations across 64 files**.
- `npm test` before fix: 497/497. After fix: 515/515 (18 new tests covering the gate, the registry, the bulk-import entry point).
- `npm run verify` after fix: syntax 124 ok / boundaries 0 / format 125 ok.
- Two clean-checkout `npm test` passes recorded in `docs/level-boundary-acceptance.md`.
- Five CI runs on `origin/main` (commits `7d137a2`, `cea8d34`, `0bda498`, `4568f55`, `9009090`) all green.

### Audit trail
- Plan: `docs/superpowers/plans/2026-08-24-architecture-boundary-enforcement.md`
- Acceptance: `docs/level-boundary-acceptance.md`
- Runtime governance: `session-c1e82ef3781e` (initial review), `session-c6aa3eb0ba63` (post-fix review). Hash chain intact in `.devflow-runtime/events.jsonl`.

---

## Gap 2 — `REFUSE_ACTIONS` two-layer semantics — OPEN

### What we have
`core/adapters.mjs` declares:
```js
export const REFUSE_ACTIONS = new Set(['force-push', 'branch-delete', 'reset-hard', 'uninstall-managed']);
```
The DevFlow Runtime sister project (`D:\5-Project\20260819\devflow-runtime`)
has its own scope verifier that also refuses destructive git operations.

### What's unclear
The two refusal layers both block the same destructive actions, but the
boundary between them isn't documented. The Workbench-side `REFUSE_ACTIONS`
acts as a "preflight" check; the DevFlow Runtime-side check is the
authoritative one (per `docs/superpowers/specs/2026-08-23-dsh-core-plugin-architecture-design.md`).
If they ever drift, an action could be refused by one and accepted by the
other, which would be a governance regression.

### Proposed fix
A future Level-shaped plan should:
1. Write a contract test (`tests/trust-boundary.test.mjs`) that asserts the
   two refusal sets agree on the same inputs.
2. Document in `docs/ENGINEERING.md` §"Trust boundary" the explicit two-layer
   model: Workbench preflight (advisory, fast) → DevFlow Runtime
   authoritative check (binding, recorded in EventStore).
3. Add `gap-2-acceptance.md` mirroring `level-boundary-acceptance.md` shape.

### Why it can wait
- The current behavior is "both refuse, sometimes twice." That's correct,
  just wasteful — no security regression.
- Closing this gap requires cross-project coordination (workbench-agent +
  devflow-runtime), which is best done as its own plan, not in this audit.

---

## Gap 3 — graphify schema extraction noise — OPEN (defer)

### Symptom
The 1,248-node, 2,460-edge graph extracted from this repo has **334
dangling-endpoint edges (≈13.5%)**. Most come from `schemas/workspace.schema.json`
— the AST extractor turns JSON-schema property names into code-graph
nodes, then tries to connect them as if they were import references.

### Why defer
This is a `graphify` bug, not a workbench-agent bug. Fixing it means
adding a schema-adapter to `graphify` (or a post-extraction filter for
`*.schema.json` sources). It does not affect runtime behaviour of the
workbench.

### Proposed fix (when picked up)
A new graphify issue; out of scope here.

---

## Gap 4 — dashboard data-flow E2E test — OPEN

### Symptom
`tests/web.test.mjs` exercises the dashboard's HTTP surface: status JSON,
evaluation filter API, static-asset serving. It does **not** exercise the
end-to-end loop `pipeline run → events → /api/status`.

### Risk
A bug that breaks the actual data flow (e.g. `StateStore.appendRow`
silently drops a row that the dashboard reads) would not be caught by
either unit test.

### Proposed fix
Add `tests/dashboard-data-flow.test.mjs`:
1. Run a minimal pipeline (small task graph, fake adapter).
2. Wait for the run to complete.
3. Hit `/api/status` and `/api/evaluation`.
4. Assert the returned shape matches the recorded events.

### Effort
Small — a few hundred lines of test code, no production changes.

---

## Gap 5 — L7 remote-package download E2E — OPEN

### Symptom
`core/packages-l7.mjs` validates manifest, source, checksum, sandbox
verification. Tests use only local-path fixtures. A package that
declares `source.type: 'http'` or `source.url: https://...` is rejected by
manifest validation, but the network-rejection branch is not actually
exercised against a real (or fake) remote source.

### Risk
A future regression in the manifest validator (e.g. `if (type === 'http') reject`
becomes `if (type !== 'local' && type !== 'git') reject`) would silently
allow http sources.

### Proposed fix
Add a fixture at `fixtures/l7/remote-package/` containing a fake remote
(bare git repo or local "http" stand-in) and a test that:
1. Writes a manifest referencing the fake remote.
2. Runs `installPackage`.
3. Asserts the network-rejection branch fires before any code from the
   package runs.

### Effort
Small to medium.

---

## Gap 6 — CLI / `--help` documentation sync gate — OPEN

### Symptom
`README.md` lists 16 CLI commands. `src/workbench.mjs --help` is the
single source of truth. They can drift. The project's
`docs/ENGINEERING.md` says "If a level adds a new CLI command, run
`node src/workbench.mjs --help` after the merge — the help text is the
README's source of truth" — that's a human check, not a gate.

### Proposed fix
Write `scripts/check-cli-docs.mjs`:
1. Parse `README.md` for the CLI commands section.
2. Run `node src/workbench.mjs --help`.
3. Diff the two; exit non-zero if README lists a command `--help` doesn't, or vice versa.

### Effort
Very small — ~50 lines of script.

---

## Where to look

| Thing | Location |
|---|---|
| Plan that produced this work | `docs/superpowers/plans/2026-08-24-architecture-boundary-enforcement.md` |
| Acceptance for gap 1 | `docs/level-boundary-acceptance.md` |
| Gate implementation | `scripts/check-boundaries.mjs` (matrix at the top of the file) |
| Registry surface | `core/adapters.mjs` (`registerAdapter` / `getAdapter` / `listAdapters`) |
| Bulk-import entry point | `adapters/index.js` |
| Test for the gate | `tests/boundaries.test.mjs` |
| Test for the registry | `tests/adapter-registry.test.mjs` |
| Test for the entry point | `tests/adapters-index.test.mjs` |
| Engineering gates table | `docs/ENGINEERING.md` §"What the engineering gates enforce" |
| Runtime governance trail | `.devflow-runtime/events.jsonl` (gitignored) |

---

## Next steps (proposed)

The three smallest open gaps (4, 5, 6) can ship in one short plan
(`2026-08-24-cleanup-three-gaps.md`) without architectural risk:

1. `tests/dashboard-data-flow.test.mjs` — gap 4
2. L7 remote-fixture + test — gap 5
3. `scripts/check-cli-docs.mjs` wired into `ci` and CI workflow — gap 6

Each task ~30 minutes; total ~2 hours; no production code changes
beyond the new scripts and tests.

Gap 2 deserves its own plan because it crosses the workbench/devflow
boundary. Gap 3 lives in `graphify`, not here.

---

## Reviewer notes

- The plan that produced gap 1's fix was authored through a
  `DevflowSession` with `intent_id = "intent-arch-boundary-plan-2026-08-24"`.
  The plan file itself is the artifact; the runtime's EventStore has the
  hash chain proving it was committed through the Action Gateway.
- Two review sessions (initial + post-fix) used
  `intent_id = "intent-arch-boundary-review-2026-08-24"` and
  `intent_id = "intent-arch-boundary-review-final-2026-08-24"`. Both
  reported `event_store_integrity: True` and
  `audit_report.pass_count: 4 / fail_count: 0`.
- The post-fix review session caught the trailing-newline bug that the
  initial `npm test` and `npm run ci` runs missed. The runtime did not
  catch it directly — running `npm run verify` did. But the review
  session was the trigger for me to run the full gate suite.
