# CLI Reference

The workbench CLI exposes the following commands.

## Workspace commands

- `workbench plan` previews installation steps from the manifest.
- `workbench apply` applies the plan (dry-run by default).
- `workbench verify` re-detects workspace health.
- `workbench sync` snapshots, locks, and syncs projects.

## Task commands

- `workbench task simulate` executes a task graph with simulated handlers.
- `workbench task run` runs a governed task through the DevFlow Runtime.

## Pipeline commands

- `workbench pipeline list` lists pipeline templates.
- `workbench pipeline simulate` compiles a template without executing.
- `workbench pipeline run` executes a pipeline.
- `workbench pipeline status` shows stage states for a run.

## Exit codes

- `0` success
- `1` failure
- `2` usage error
- `3` quarantined state
