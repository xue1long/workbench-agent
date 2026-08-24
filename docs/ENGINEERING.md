# Engineering Notes

Why the Agent Workbench Runtime is structured the way it is, and how to evolve it without breaking the trust boundaries.

## Single-package layout (current)

```
.
├── src/                  CLI shell (`workbench` command); thin IO + dispatch
├── core/                 Pure orchestration, pipeline, knowledge, trajectory, evaluation, canary,
│                         candidates, intelligence, experiment lab, evidence graph, packages
├── adapters/             Process / codex / claude-code / devflow-runtime / git / python / node / uv
├── apps/web/             Read-only dashboard (Express-free, vanilla DOM)
├── schemas/              JSON Schemas (e.g. workspace.schema.json)
├── fixtures/             Deterministic test inputs, knowledge benchmark, intelligence fixtures
├── docs/                 Per-level plans, per-level acceptance docs
├── scripts/              check-syntax / check-format / check-commit-msg / check-version / release-dry-run
├── .github/              CI workflows, dependabot, issue + PR templates
├── .gitattributes        Force LF for every text file regardless of core.autocrlf
├── package.json          Zero runtime dependencies; Node 20+ ESM
└── README.md / LICENSE / CONTRIBUTING / SECURITY / CODE_OF_CONDUCT / CHANGELOG
```

`src/workbench.mjs` is the only file that owns side effects on the user's behalf (CLI args, environment, stdout/stderr). Everything else is pure: given the same input, the same output. This is intentional — it is exactly the boundary that a future monorepo split would carve along.

## Zero runtime npm dependencies (a governance rule)

`package.json` ships with `"dependencies": {}` and the runtime relies only on Node 20+ built-ins (`node:fs`, `node:path`, `node:child_process`, `node:test`, `node:crypto`, `node:http`). Adding a runtime dependency is a **governance** decision, not a code-review decision:

1. Open an issue describing what you need, what built-in alternatives you considered, and the security model.
2. Get approval in the matching level doc (`docs/level-N-acceptance.md`).
3. Only then add it to `package.json`.

Dependabot is configured to ignore `production` dependency-type updates (see `.github/dependabot.yml`) precisely to enforce this rule.

## Why not a monorepo (yet)

The README asks the same question and the answer is: **the boundary already exists; the boundary is already respected; the pain is not on the horizon yet.** Carving the repo into `@workbench/core`, `@workbench/dashboard`, `@workbench/cli` would:

- Force an npm workspaces / pnpm setup and a build step (currently `node --check` is the entire build).
- Move every `import './core/foo.mjs'` to `import '@workbench/core/foo.mjs'` (≈ 50 files) plus a packaging step for the export map.
- Add a dependency-graph CI matrix (lint / typecheck / test for each workspace + integration tests) without buying a clear capability boundary.

What the current layout **does** buy:

- `core/` is import-pure, has no global state, no `process.env` outside explicitly-injected options. Re-exporting any of `core/` from a future `@workbench/core` package would be a mechanical change (rename internal imports, add a `package.json` per workspace).
- The trust boundary (DevFlow Runtime is the only thing that mutates governed state) is encoded in the **shape** of the modules (`Orchestrator.runTask`, `PipelineRunner.run`, `ExperimentLab.routeToCanary`), not in the package layout. A split wouldn't change that.

The trigger to **actually** split is one of:

- Three independent teams touching `core/`, `apps/web/`, and `adapters/` at the same cadence.
- A need to release `@workbench/core` to npm without dragging the dashboard.
- A second downstream consumer of `core/` (e.g. an IDE plugin) that we do not want to share a release cadence with.

Until one of those lands, single-package is cheaper and simpler.

## The boundary contract (so the split stays mechanical)

If/when we split, this is the surface each workspace exposes:

| Package | Path today | Path after split |
|---|---|---|
| CLI shell | `src/workbench.mjs` | `@workbench/cli` (bin: `workbench`) |
| Pure orchestration | `core/` | `@workbench/core` (everything in `core/`, except `core/intelligence/` and `core/laboratory/`) |
| Intelligence | `core/intelligence/` | `@workbench/intelligence` (depends on `@workbench/core` types) |
| Experiment Lab | `core/laboratory/` | `@workbench/lab` (depends on `@workbench/core` + `@workbench/intelligence`) |
| Dashboard | `apps/web/` | `@workbench/dashboard` (depends on `@workbench/core` types only) |
| Adapters | `adapters/` | `@workbench/adapters` (depends on `@workbench/core`) |

Inter-package imports that must be allowed:

```
@workbench/cli             -> @workbench/core, @workbench/adapters
@workbench/dashboard       -> @workbench/core
@workbench/lab             -> @workbench/core, @workbench/intelligence
@workbench/intelligence    -> @workbench/core
@workbench/adapters        -> @workbench/core
```

Anything else (e.g. `core` depending on `apps/`, `adapters` reaching into `intelligence/`) is a layering bug. The current codebase has none of those; CI's `check-boundaries` gate (added 2026-08-24 by `docs/superpowers/plans/2026-08-24-architecture-boundary-enforcement.md`) prevents accidental new ones. The matrix in that script's `MATRIX` constant is the single source of truth — adding a new subtree means extending the matrix, not weakening the rules.

## What the engineering gates enforce

| Gate | Script | Catches |
|---|---|---|
| Syntax | `npm run check` | parse errors, missing files |
| Format | `npm run format:check` | CRLF, trailing whitespace, mixed indent, missing final newline |
| Commit message | `npm run lint:commit` | non-Conventional-Commits, missing scope rules, oversize subject |
| Version | `npm run version:check` | package.json version missing from CHANGELOG.md |
| Boundary contract | `npm run check:boundaries` | core -> adapters reverse imports, intelligence <-> laboratory direction, adapters -> apps, src -> concrete adapters (CLI bootstrap only); see "The boundary contract" below |
| Release readiness | `npm run release:dry-run` | combines all of the above + working-tree cleanliness |
| Tests | `npm test` | behavioral regressions (515 tests across L1–L7 plus the boundary, registry, and adapters-index suites) |
| CI | `npm run ci` | syntax + boundaries + tests (the local fast loop) |
| CI (full) | `.github/workflows/ci.yml` | the same + Node 20/22/24 matrix + DevFlow Runtime pytest job |

## When you add a level

The pattern (mirrors Level 2 → Level 7):

1. Write `docs/superpowers/plans/2026-08-23-level-N-*.md` (Global Constraints + Phase 0 + Tasks + Exit gate + Stop line + DoD + Deliberate Deferrals).
2. Create `workbench-lN` worktree.
3. Implement task by task; one commit per task.
4. Write `docs/level-N-acceptance.md` (gate status, fixture outcome, command list, stop-line review).
5. Run `npm test` twice from a clean checkout; both passes must be green.
6. Merge to `main` with `--no-ff`.

If a level adds a new CLI command, run `node src/workbench.mjs --help` after the merge — the help text is the README's source of truth and the README is the contributor's first stop.

## Reproducible baseline

The `.devflow-runtime/` and `.workbench/` directories are runtime scratch (already in `.gitignore`). To delete them and re-bootstrap:

```bash
rm -rf .workbench .devflow-runtime
npm test
```

`npm test` writes nothing to `.workbench/` (it uses `mkdtempSync` for per-test temp dirs). The CLI does write to `.workbench/store/` only when invoked with a real manifest — the integration tests use `mkdtempSync` for the same reason.
