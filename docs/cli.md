# workbench CLI — M4 reference

This document is the authoritative reference for the `workbench` command-line interface. It is generated alongside the runtime; if you find drift, please update both.

## Synopsis

```text
workbench [command] [options]
```

`workbench` reads a single `workspace.json` (or `workspace.yaml` if you ship one and we have a parser) from the current directory, unless `--manifest PATH` is supplied.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success or `--help` |
| 1 | manifest error (parse, validation, missing file, schema violation) |
| 2 | unknown command |
| 3 | YAML manifest (M2 does not parse YAML; convert to JSON) |
| 4 | apply / sync / restore / rollback step failed |

Every non-zero exit is paired with a single-line `workbench: <message>` on stderr.

## Commands

### `workbench init`

Write a starter `workspace.json` in the current directory. Refuses to overwrite an existing one.

### `workbench plan [--manifest PATH]`

Preview the install / update / skip steps derived from the manifest + observed state. **No mutations.** Reads observed versions from `WORKBENCH_<RESOURCE>_VERSION` env vars (so it is reproducible in CI).

### `workbench apply [--manifest PATH] [--apply]`

Route the plan through the registered adapters. Default is **dry-run** (preview only). Pass `--apply` to actually call adapter `install` / `update`.

### `workbench verify [--manifest PATH]`

Re-read the manifest + observed state and print a workspace health summary.

### `workbench sync [--manifest PATH] [--apply] [--no-git] [--skip-projects]`

The "Machine A" half of the M4 acceptance scenario. Captures a snapshot of managed files, runs the apply engine, writes `workspace.lock` next to the manifest, and (unless `--no-git` or `--skip-projects`) syncs declared projects via `git clone` / `fetch`.

- Default is **dry-run** (no lockfile written).
- `--no-git` disables network clones for git sources but still creates local-source project directories.
- `--skip-projects` skips every project action.

### `workbench restore [--manifest PATH] [--apply]`

The "Machine B" half. Reads the manifest + (optional) `workspace.lock`. If a lockfile is present, its pinned versions are used as the observed baseline (so a clean VM plans SKIP, not spurious INSTALL). On lockfile drift (manifest versions newer than lockfile), restore refreshes the lockfile automatically. Re-running on a converged host reports`NO CHANGES`.

### `workbench rollback --to <snapshotId>`

Restore managed files from a named snapshot under `.workbench/snapshots/`. Snapshots are created by `sync` and by future `apply` invocations. Lists available snapshots when the requested id is unknown.

### `workbench status [--manifest PATH]`

Print current observed state + a one-line plan.

### `workbench project list [--manifest PATH]`
### `workbench agent list [--manifest PATH]`
### `workbench mcp list [--manifest PATH]`
### `workbench package list [--manifest PATH]`

Read-only list commands.

## Manifest schema

See `schemas/workspace.schema.json`. The hard-required fields are:

- `version: "1"`
- `workspace.id` — ASCII identifier (`[A-Za-z0-9._-]+`)
- `environment` — object whose keys are restricted to`node | python | uv`, with `version` strings matching `[A-Za-z0-9._+\-:]`

Optional sections:

- `projects: Project[]`
- `agents: AgentDeclaration[]`
- `skills: Skill[]`
- `mcp: Mcp[]`
- `packages: Package[]`
- `settings.auto_update` / `verify_after_apply` / `stop_on_failure`

## Environment variables

| Variable | Effect |
| --- | --- |
| `WORKBENCH_NODE_VERSION` | Override observed node version for `plan`. |
| `WORKBENCH_PYTHON_VERSION` | Override observed python version for `plan`. |
| `WORKBENCH_UV_VERSION` | Override observed uv version for `plan`. |
| `<SECRET_NAME>` | Resolved via the secret store; see `core/secrets.mjs`. Never logged, never persisted. |

## Safety policy

- `git` adapter refuses `force-push`, `branch-delete`, `reset-hard` by default.
- `BaseAdapter.uninstall` refuses unless the concrete adapter overrides it.
- Configuration paths are sandboxed to the workspace root; traversal is rejected.
- Secret references in manifests are redacted before being written to disk or emitted in CLI output.
- The JSONL state store at `.workbench/store/<workspaceId>/` is redacted on write; secret values never appear in audit records.

## State persistence

Machine-scoped state lives under `.workbench/`:

```
.workbench/
├── store/<workspaceId>/
│   ├── workspace.jsonl
│   ├── resource.jsonl
│   ├── execution.jsonl
│   ├── verification.jsonl
│   └── audit.jsonl
└── snapshots/<snapshot-id>/
    └── <copy of every captured file>
```

The on-disk format is one JSON object per line; corrupt lines are skipped on read. A SQLite-backed implementation can be swapped in by implementing the same `StateStore` interface.
