# Security

The Agent Workbench Runtime is the orchestration layer for a governed agent environment. Source-code mutations flow through the DevFlow Runtime Python project's Action Gateway only after explicit human approval; the Workbench itself never edits user files directly.

## Trust boundaries in scope

- **Action Gateway only.** Every governed source-code mutation passes through `core/orchestrator.mjs` → `adapters/devflow-runtime.mjs` → `devflow_runtime` Python runtime → Action Gateway. No code path writes to user files outside that gate.
- **Runtime disabled by default.** `config/runtime.yaml` ships with `enabled: false`. The runtime must be explicitly enabled before any governed run.
- **Human approval receipt required.** `runTaskRun` / `runPipelineRun` only call into the Runtime when `approveChangeSet` returns `approved: true` with an actor and a sha256-matching change-set digest.
- **Append-only lifecycle history.** Trajectory, evaluation, candidate, benchmark, experiment, and package-install rows are append-only. Rollback appends a history row, never deletes.
- **Sandbox verification.** Every package install passes through a sandbox verifier; a tampered checksum or a verifier-exit-non-zero is rejected before any code from the package runs.

## Reporting a vulnerability

Please **do not** file a public GitHub issue for security-sensitive reports.

Email `security@workbench-agent.example` (replace with your real contact before publishing). Use a PGP key published alongside this repository when possible. Expect:

- An acknowledgement within **3 business days**.
- A triage decision within **7 business days**.
- A fix or mitigation timeline within **14 business days** for confirmed issues.

## Out of scope

- Vulnerabilities in the DevFlow Runtime Python project (`devflow_runtime`) — file them against that project instead.
- Vulnerabilities in third-party agent CLIs (Claude Code, Codex CLI, etc.) — file them against the upstream vendor.
