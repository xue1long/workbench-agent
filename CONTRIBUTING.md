# Contributing

Thanks for taking the time to contribute. The Agent Workbench Runtime is the orchestration layer for a governed agent environment: orchestration, pipeline, knowledge, evaluation, evolution, intelligence, experiment, packages. Contributions should respect the trust boundaries — DevFlow EventStore is the source of truth for governed state, every governed code mutation flows through the Action Gateway, and every promotion requires explicit human approval.

## Ground rules

- **Zero runtime npm dependencies.** Anything that runs at `npm test` or `npm start` time must come from Node 20+ built-ins. Adding a runtime dependency is a governance decision, not a code-review decision — open an issue first.
- **Tests come first.** Every change ships with failing tests first, then implementation, then `npm test` passing twice from a clean checkout. `npm test` runs `node --test tests/*.test.mjs` — no extra runner.
- **No raw prompt, stdout, stderr, or context** in any persisted row. Trajectory, evaluation, candidate, benchmark, experiment, and package records carry only hashes, byte counts, paths, scores, and citations.
- **Determinism over cleverness.** Given the same input, every module must produce the same output. No wall-clock dependence in scoring, no random ordering, no global state.
- **One level, one branch.** Each level ships on `workbench-lN` and is merged to `main` only after the second full pass of `npm test`.

## Commit messages — Conventional Commits

```
<type>(<optional-scope>): <subject>

<optional body — wrap at 72 cols>

<optional footer — references, breaking-change notes>
```

Allowed `<type>` values:

| Type | When |
|---|---|
| `feat` | A new user-facing capability (new module, new CLI command, new acceptance gate). |
| `fix` | A user-facing bug fix. |
| `refactor` | Internal restructuring with no user-facing change. |
| `test` | Adding tests or improving the test harness only — no production code change. |
| `docs` | Documentation only — README, acceptance doc, plan doc, CHANGELOG. |
| `chore` | Tooling, build, CI, scripts, .gitignore, editorconfig. |
| `perf` | A measurable performance improvement. |

Subject line rules:
- Imperative mood ("add X", not "added X" or "adds X").
- Lowercase after the type prefix, no trailing period.
- Max 72 chars.

A pre-commit hook (`.githooks/pre-commit` → `npm run lint:commit`) verifies this on every commit.

## Branch + level workflow

```
workbench-lN  ←  every task is one commit, one failing test passes, then next commit
       │
       │  after the second full `npm test` run from a clean checkout passes
       ▼
     main
```

1. Create the worktree: `git worktree add -b workbench-lN ../workbench-lN main`.
2. Write the detailed plan first under `docs/superpowers/plans/2026-08-23-level-N-*.md`.
3. Implement task by task with TDD; each task is one commit (`feat: …`, `test: …`, `docs: …`).
4. Run `npm test` after every task.
5. Write `docs/level-N-acceptance.md` with gate status, test counts, benchmark numbers, acceptance fixtures, DoD checklist.
6. Run the full suite twice from a clean workspace; both passes must be green.
7. Merge with `--no-ff`: `git merge --no-ff workbench-lN -m "merge: level N <short-name>"`.

## Code style

- Node 20+ ESM only (`"type": "module"`). No CommonJS, no Babel, no TypeScript.
- Two-space indent, LF line endings, UTF-8 (see `.editorconfig`).
- Files end with a single trailing newline.
- Functions are pure unless they own the side effect they declare (`orchestrator.runGraph` owns the Runtime submission; `pipeline-runner.run` owns the artifact persistence).
- Errors are typed: `defineXxxError` classes with stable `code` strings.
- Every `core/` module exports the operations a test or sibling module needs — no default exports.
- Comments explain *why* a guard exists, not *what* the code does.

## Testing discipline

- Tests live under `tests/<module>.test.mjs` and use the built-in `node:test` runner.
- Each acceptance gate has a dedicated `tests/<level>_e2e.test.mjs`.
- Determinism is asserted (`assert.deepEqual(run(...), run(...))`) wherever randomness or ordering could leak in.
- Sandbox verification tests use real `fs.mkdtempSync` directories and `fs.rmSync(... recursive)` cleanup.
- The DevFlow Runtime Python tests live in a separate job in CI and are not run from this repository.

## Pull request checklist

- [ ] `npm test` is green twice from a clean checkout (locally or in CI).
- [ ] `npm run check` is green (syntax).
- [ ] `npm run format:check` is green.
- [ ] New behavior is covered by failing tests in the relevant `tests/*.test.mjs`.
- [ ] If the change adds a level, `docs/level-N-acceptance.md` is updated and the plan is updated.
- [ ] If the change touches `core/intelligence/`, `core/laboratory/`, `core/packages-l7.mjs`, or `core/graph.mjs`, the matching per-level acceptance doc is reviewed for traceable claims.
- [ ] If the change adds a CLI command, the command shows up in `node src/workbench.mjs --help`.
- [ ] Commit messages follow the table above.

## Reporting issues

- Bug reports: use the `.github/ISSUE_TEMPLATE/bug_report.md` template.
- Feature requests: use the `.github/ISSUE_TEMPLATE/feature_request.md` template.
- Security issues: see `SECURITY.md` — do **not** file a public issue.

## Code of conduct

See `CODE_OF_CONDUCT.md`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
