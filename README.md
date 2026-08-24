# Agent Workbench Runtime

> Local-first, declarative, reproducible runtime for agent environments. Orchestrates governed runs (L2), drives a standard development pipeline with scoped knowledge (L3), measures how well it did (L4), proposes and canaries candidate improvements with explicit human approval (L5), ingests external technology into traceable patterns (L6), and binds everything into an evidence graph with an isolated experiment lab and a sandbox-verified package ecosystem (L7).

[![Node >= 20](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-497%20passing-brightgreen)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Zero runtime deps](https://img.shields.io/badge/runtime%20deps-zero-blueviolet)](./package.json)

---

## What it is

A single-package Node 20+ ESM workspace runtime with **zero runtime dependencies**:

- `core/` — pure orchestration, pipeline, knowledge, trajectory, evaluation, candidates, intelligence, experiment lab, evidence graph, package ecosystem (L2–L7).
- `adapters/` — process agent, codex, claude-code, devflow-runtime, git, python, node, uv (L1+L2).
- `apps/web/` — read-only dashboard (M5) exposing workspace health + L4 evaluation filters.
- `src/workbench.mjs` — the `workbench` CLI shell (plan, apply, verify, sync, restore, rollback, init, status, task, pipeline, knowledge, memory, agent, mcp, package, project).
- `fixtures/` — deterministic test inputs, knowledge benchmark, intelligence fixtures, live-path oauth-demo.
- `docs/level-{2..7}-acceptance.md` — per-level gates, evidence, and stop-line review.

The governed path (source-code mutations) flows through the DevFlow Runtime Python project (`devflow_runtime`) over the stable JSON/YAML protocol; the Workbench never edits user files directly — it submits version-bound `file_edit` Actions only.

## Install

Requires Node 20+. No npm install needed — the runtime has zero runtime dependencies.

```bash
git clone https://github.com/xue1long/workbench-agent.git
cd workbench-agent
npm test                       # 497 tests, no network
node src/workbench.mjs --help  # show all commands
```

## Quick start

```bash
# Bootstrap a workspace
node src/workbench.mjs init --manifest workspace.json

# Preview / apply environment changes (M1+M2+M3)
node src/workbench.mjs plan
node src/workbench.mjs apply --apply

# Verify the workspace
node src/workbench.mjs verify

# Run a standard development pipeline (L3)
node src/workbench.mjs pipeline list
node src/workbench.mjs pipeline run \
  --template standard-development \
  --goal "Add OAuth login" \
  --approve-changes

# Evaluate and trace (L4)
node src/workbench.mjs memory list --scope src/
node src/workbench.mjs knowledge benchmark

# Promote a candidate (L5)
# (typically driven from the experiment lab, not the CLI)

# Intelligence, experiment, packages (L6+L7)
node src/workbench.mjs knowledge benchmark --fixture ./fixtures/knowledge/benchmark/documents
```

Every command exits with a documented code: `0` success, `1` failure, `2` usage error, `3` quarantined state.

## Architecture (one minute)

```text
                   ┌─────────────────────────────────────────────┐
                   │ core/  (zero-dependency orchestration)        │
                   │                                              │
                   │ task-graph  workflow-runtime  orchestrator   │
                   │ pipeline    pipeline-runner   templates      │
                   │ trajectory  evaluation        evaluators     │
                   │ candidates  canary            benchmark      │
                   │ knowledge   retrieval         memory         │
                   │ intelligence sources / ingest / patterns     │
                   │ experiment   graph             packages-l7    │
                   └──────────────┬───────────────────────────────┘
                                  │ stable JSON/YAML protocol
                                  ▼
                   ┌─────────────────────────────────────────────┐
                   │ DevFlow Runtime (Python 3.11+, devflow_runtime)│
                   │ Action Gateway  EventStore  canary rollback   │
                   └─────────────────────────────────────────────┘
```

- `core/` is **pure** — no LLM SDK imports, no network calls, no global state. Deterministic given a fixed input.
- Trajectory and evaluation rows are append-only projections. DevFlow EventStore remains the sole source of truth for governed state.
- Every candidate lifecycle transition is append-only; rollback restores the previous version without deleting history.
- Package installs go through sandbox verification — a tampered checksum or a verifier-exit-non-zero is rejected before any code from the package runs.

See `docs/level-{2..7}-acceptance.md` for the per-level gates, evidence, and stop-line review.

## Scripts

| Script | What it does |
|---|---|
| `npm test` | Run the full Node test suite (497 tests across L1–L7). |
| `npm run check` | Syntax check every `*.mjs` and `*.js` file under `core/`, `adapters/`, `apps/`, `src/`, `tests/`. |
| `npm run lint:commit` | Verify the staged commit message matches Conventional Commits (called from CI). |
| `npm run format:check` | Verify that every `*.mjs` and `*.js` file matches the `.editorconfig` rules (no format mutation, only check). |
| `npm run verify` | `check` + `lint:commit` (local pre-commit hook). |
| `npm start` | Start the `workbench` CLI shell. |
| `npm run version:check` | Assert the manifest version in `package.json` matches `docs/level-*-acceptance.md` (helps catch stale docs). |

DevFlow Runtime Python tests live in a separate job in CI and are not run from this repository.

## Engineering & monorepo boundary

The project is a single-package repository. The `core/` directory is intentionally import-pure and free of global state, which is exactly the boundary a future monorepo split would carve along (`@workbench/core`, `@workbench/dashboard`, `@workbench/cli`). The `package.json` `exports` field is structured to make that split mechanical. See `docs/ENGINEERING.md` for the rationale, the boundary contract, and the migration plan.

## Architecture audits

Honest periodic assessments of where the architecture actually stands — what's enforced, what's documented but not gated, and what's open. Each audit links to its plan(s), acceptance doc(s), and the runtime governance trail.

- `docs/architecture-self-audit-2026-08-24.md` — baseline audit; closed gap 1 (`core/` → `adapters/` reverse dependencies), identified gaps 2-6.



## Repository conventions

- Conventional Commits on every commit (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`).
- Each level ships with a detailed plan (`docs/superpowers/plans/2026-08-23-level-{N}-*.md`), a per-level acceptance doc (`docs/level-{N}-acceptance.md`), and a working branch `workbench-l{N}` that is merged to `main` only after the second full pass of `npm test`.
- Zero runtime npm dependencies; devDependencies are intentionally empty. Adding a dep is a governance decision.
- Sandbox verification is mandatory for any code-bearing artifact (packages, experiments).

## Security

- `runtime.yaml` (DevFlow Runtime config) defaults to `enabled: false`.
- All governed source-code mutations require an explicit human approval receipt before the Action Gateway is invoked.
- Full content for ingested external sources is stored only when license, terms, retrieval permission and retention class are all recorded.
- See `SECURITY.md` for reporting vulnerabilities.

## Contributing

See `CONTRIBUTING.md`. Issues and PRs use the templates under `.github/`.

## License

[MIT](./LICENSE) — see the file for the full text.

## Acknowledgements

- `core/` is pure ESM, no npm runtime dependencies; the runtime relies only on Node built-ins.
- The DevFlow Runtime Python project (`D:\5-Project\20260819\devflow-runtime`) provides the governed EventStore, Action Gateway, and protocol.
