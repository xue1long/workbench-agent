# Level 2 Acceptance Summary

> Snapshot of the Agent Workbench Level 2 implementation, recorded by the
> Workbench-Agent on 2026-08-23. All numbers below come from the Workbench
> npm test suite and the DevFlow Runtime pytest suite run from the
> respective repository checkouts.

## Gate Status

| Gate | Status | Evidence |
| --- | --- | --- |
| Repository | PASS | `git rev-parse --show-toplevel` succeeds; Workbench baseline committed (`fb11918`). |
| Provider | PASS | `claude --help` and `claude -p "noop"` succeed in a fresh temporary Git repo; `codex-cli 0.146.0` is on PATH. No-op probe did not modify the workspace. |
| Runtime | PASS | `devflow-runtime` suite is 338/338 after the Phase 0 fixes (session isolation, test_command plumbing, fixed-clock authorizations, two-session regression, test_command Evidence protocol). |

## Test Counts

- Workbench npm test baseline: 186/186
- Workbench npm test after Tasks 1-12: 298/298 (Tasks 1-6 used deterministic fixtures; Tasks 7-12 used the public ``runTask`` boundary with deterministic planner/invoker/Runtime doubles).
- DevFlow Runtime pytest baseline: 333/333
- DevFlow Runtime pytest after Phase 0: 338/338 (added `tests/test_two_session_isolation.py` and `tests/test_test_command_evidence.py`).

## Commits

- `devflow-runtime` `27f222b`: fix(tests): derive authorization timestamps from current UTC clock
- `devflow-runtime` `01531ca`: fix(runtime): isolate consecutive sessions, plumb test_command
- Workbench `fb11918`: chore: initialize Workbench git repo with baseline state
- Workbench `workbench-l2` branch (each step is its own commit):
  - `feat: add validated task graph`
  - `feat: persist orchestration events`
  - `feat: execute sequential task workflows`
  - `feat: add bounded workflow recovery`
  - `feat: support bounded parallel workflows`
  - `feat: route tasks with deterministic scoring`
  - `feat: govern source changes with devflow runtime`
  - `feat: invoke agents inside change sandboxes`
  - `feat: plan tasks through a validated provider boundary`
  - `feat: compose safe live task orchestration`
  - `feat: expose simulated and live task execution`
  - `test: establish level 2 acceptance gate`

## Acceptance Fixtures (Tests/orchestration_e2e.test.mjs)

Nine success fixtures:

1. sequential OAuth graph
2. fan-out / fan-in
3. reviewer success
4. reviewer correction + replan
5. retry success
6. retry exhaustion
7. fallback success
8. no eligible agent
9. thrown Agent error normalised

One expected-failure fixture:

- budget/deadline termination

Governance (fail-closed) fixtures:

- corrupt EventStore integrity refuses to map Runtime finish to COMPLETED
- change-sandbox rejects candidates with > 5 files
- change-sandbox rejects binary content

Session isolation fixture:

- two consecutive Runtime sessions in one workspace produce disjoint runIds.

Bounded live OAuth acceptance:

- copies `fixtures/live/oauth-demo` to a fresh temp directory, runs `npm test`, and asserts the live candidate touches at most 5 UTF-8 text files.

## Trust Boundary Checklist

- Agent evidence stays as ``EvidenceClaim`` and never carries ``trusted: true``.
- ``EXECUTION_SUCCEEDED`` does not map to ``COMPLETED``; only valid EventStore
  integrity plus ``finish`` Decision may.
- Corrupt EventStore integrity maps to ``QUARANTINED``.
- Runtime Action Gateway is the only mutation entry point.
- The change-sandbox refuses binary / delete / rename and > 5 files before
  invoking Runtime.
- `config/runtime.yaml` defaults to ``enabled: false``.
- Raw prompt / context / stdout / stderr fields are replaced by sha256 + byte
  digest metadata before persistence.

## Live CLI Field Acceptance (2026-08-23, second pass)

The `workbench task run` CLI is now wired to the **real** devflow-runtime
process (no mock runner). Verified in a temporary Git workspace with
`config/runtime.yaml` set to `enabled: true` and a manifest-declared Agent
carrying a real `invocation`:

| Scenario | Result |
| --- | --- |
| `task run --goal "update README" --approve-changes` | `finalStatus: COMPLETED`, `decision: finish`, `EXECUTION_SUCCEEDED`; README.md changed by the live agent; EventStore integrity `valid: true`; session `finished` |
| `task run --goal "update README again"` (no approval) | `finalStatus: AWAITING_APPROVAL`, `decision: continue`; EventStore byte count unchanged — no Runtime Action submitted |
| Runtime disabled workspace | CLI refuses with "DevFlow Runtime is disabled for this workspace. Set `enabled: true` in config/runtime.yaml" |
| No invokable Agent | CLI refuses with a clear message to declare `invocation` in workspace.json |

This closes the last gap between the unit/integration coverage and the CLI
surface: the governance path (sandbox → change-set → approval → Runtime
Action → trusted Evidence → finish) is exercised end-to-end against a real
`devflow-runtime` process.

## Known Limits

- The live provider scenario is bounded by the offline oauth-demo fixture;
  no real network calls or credentials are exercised.
- The provider gate relies on the Claude CLI returning a structured no-op
  response; the ``BLOCKED_PROVIDER_GATE`` path is not exercised because at
  least one provider completes the no-op probe.

## Definition of Done

- [x] Task graphs are validated and explain dependency failures.
- [x] Sequential, parallel, fan-out, fan-in, review, retry, fallback, and
      one bounded replan path are covered by executable tests.
- [x] Agent routing is deterministic, explainable, and uses the existing
      registry.
- [x] Capability definitions, Agent mappings, capability queries, and
      context-capacity rejection are deterministic and tested.
- [x] Every run has persisted digest-only projections, Evidence Claims,
      cost, duration, routing decisions, and an execution state.
- [x] Every governed run has version/session bindings, trusted Evidence
      references, valid EventStore integrity, and a Runtime Decision; only
      ``finish`` maps to final completion.
- [x] Existing environment/config mutations use Apply outside governed
      sessions; governed source changes use sandboxed, explicitly approved
      Action Proposals and only the DevFlow Action Gateway mutates the
      workspace.
- [x] Unauthorized scope, stale revision, missing/failed verifier evidence,
      corrupt EventStore, and uncertain recovery all fail closed and never
      report completion.
- [x] Two consecutive Runtime sessions in one workspace remain isolated.
- [x] One callable provider passes the bounded offline OAuth
      planning/execution/Runtime acceptance scenario within the five-file
      UTF-8 limit.
- [x] CLI behavior is documented and backward compatible.
- [x] The complete test suite and acceptance suite pass twice.
