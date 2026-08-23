# Level 3 Acceptance Summary

> Recorded for Agent Workbench Level 3 (Development Pipeline + Scoped Knowledge) on 2026-08-23, branch `workbench-l3`. All numbers come from the Workbench npm test suite run from the `workbench-l3` worktree.

## Gate Status

| Gate | Status | Evidence |
| --- | --- | --- |
| Workbench baseline | PASS | `npm test` 303/303 before Level 3 tasks |
| Level 2 exit gate | PASS | `docs/level-2-acceptance.md`; Runtime 338/338 |
| Level 3 full suite | PASS | 378/378 (see below), run twice from clean worktrees |
| E2E acceptance | PASS | five real repository tasks, oauth-demo link test, resume test, benchmark test (4/4 in `tests/pipeline_e2e.test.mjs`) |

## Test Counts

- Workbench npm test baseline (Level 2): 303/303
- Workbench npm test after Level 3 Tasks 1-11: **378/378** (second full pass: 378/378)
- DevFlow Runtime pytest (unchanged by Level 3): 338/338

## Retrieval Benchmark Baseline (fixed fixture, `fixtures/knowledge/benchmark`)

| Metric | Value |
| --- | --- |
| precision@5 (deterministic path/keyword) | **0.233** |
| sourceCoverage | **1.0** |

Notes: every gold item is retrieved in top-5 across all six queries; 0.233 equals the theoretical ceiling for this fixture's gold sizes (2+1+1+1+1+1 gold out of 5 slots each). Semantic/vector retrieval stays **deferred** — it may be added only if it improves top-5 relevance by at least 15 percentage points over this baseline (0.233 → ≥ 0.383).

## Commits (workbench-l3, oldest → newest)

1. `dd7e94e` docs: add level 3 plan and acceptance stub
2. `fdfac0d` feat: add immutable pipeline template contract
3. `93f1540` feat: add standard development pipeline template
4. `d2e3c6e` refactor: extract runGraph and add resume skipNode
5. `14d4cf5` feat: run pipelines with artifact persistence, fail-closed gate and resume
6. `9357a41` feat: expose pipeline commands in the CLI
7. `f766bad` feat: add knowledge ingestion with retention policy
8. `df8216a` feat: add deterministic scoped retrieval
9. `54cfda7` feat: add retrieval benchmark with precision and coverage
10. `fa6c8c5` feat: add durable project memory for reviewed knowledge
11. `8ee06da` feat: wire scoped knowledge into pipeline stages and add knowledge CLI
12. `e994394` test: establish level 3 acceptance gate

## Acceptance Fixtures

- **Five repository tasks through the standard pipeline** — `Add OAuth login`, `Add billing cycle`, `Add project sync`, `Add CLI commands`, `Add config validation` — each on a fresh temporary Git repository using the REAL change-sandbox (git worktree + `collectChangeSet`); all five finish `COMPLETED` with 6 succeeded stages, 6 persisted artifacts, and ≥1 real changed file.
- **oauth-demo link test** — the real `fixtures/live/oauth-demo` repository runs through the standard pipeline; the Test stage executes the repository's own `node --test tests/oauth.test.mjs` in the sandbox. Result links requirements (requirement artifact hash), changed files (real sandbox diff), test output (test-report artifact + `test` evidence claim), and review evidence (review stage claims + decision SUCCEEDED).
- **Interrupted execution resumes** — run 1 fails at Implementation (no Runtime call: `runtimeCalls == 0`, `stage_failed`); resume reuses every verified stage, re-runs only the failed stage, and the real source file is written exactly once.
- **Retrieval benchmark** reports precision@5 = 0.233 and sourceCoverage = 1.0; deterministic across runs.
- **Scope boundary** — a `src/`-scoped query never returns `docs/`/`notes/` items; pipeline stage knowledge scope is enforced twice (query scope must stay within the stage's declared scope, and `retrieve()` applies the hard boundary); a violating template fails the stage closed.

## Trust Boundary Checklist

- Agent/planner output remains `EvidenceClaim`; project memory stores only `reviewed: true` decisions (with reviewer evidence ref) and artifacts carrying `verifierVersion` + a trusted evidence kind. Unverified claims are rejected and never written (`PROJECT_MEMORY_UNVERIFIED`).
- A pipeline whose execution did not fully succeed never submits a Runtime Action and never reports completion (`stage_failed`, `finalStatus: FAILED`); only a valid Runtime `finish` maps to `COMPLETED`.
- Artifact content lives in files under `.workbench/pipelines/<pipelineId>/<stageId>/`; JSONL rows carry only path/sha256/byteCount/kind/scope/producedBy/supersedes.
- Resume reuses a stage only when its definitionHash matches AND every declared output artifact file still exists with an unchanged sha256 on disk; tampered or missing artifacts force a re-run.
- Knowledge index is append-only; deletion is a `DELETED` superseding row; `purgeUnreferenced()` removes object files no longer referenced.
- Retrieval is deterministic, budget-bounded, and cites exact `sourcePath` + `contentHash` for every returned item.
- Every stage declares inputs, output artifacts, acceptance criteria (against a Level 2 verifier), owner, and evidence; undeclared artifacts and unknown verifiers are rejected at definition or execution time.

## CLI Surface Added

- `workbench pipeline list | simulate | status | run`
- `workbench knowledge ingest | retrieve | benchmark`
- `workbench memory list`

## Level 3 Definition of Done

- [x] Pipeline templates immutable/versioned/validated; compile into ordinary Level 2 DAG nodes.
- [x] Standard template Requirement → Analysis → Plan → Implementation → Test → Review ships and runs.
- [x] Every stage declares inputs, output artifacts, acceptance criteria, owner, evidence.
- [x] Artifact content in files; JSONL rows carry metadata + hashes only.
- [x] Resume reuses only hash-verified stages; no duplicated side effects.
- [x] Knowledge ingestion with retention and append-only supersede semantics.
- [x] Deterministic scoped retrieval with hard scope boundary and context budget.
- [x] Benchmark reports precision@5 (0.233) and source coverage (1.0); semantic retrieval deferred unless ≥15-point gain.
- [x] Project memory stores only reviewed decisions and verifier-backed evidence.
- [x] Exit gate and stop line satisfied; suite passes twice (378/378).

## Stop Line Review (Level 3 → Level 4)

- Stage acceptance is never subjective-only: acceptance kinds must be in the Level 2 verifier set and are enforced by `definePipeline`/`createTaskGraph` — PASS.
- Durable memory cannot contain unverified Agent claims: `saveVerifiedArtifact` requires `verifierVersion`; `saveDecision` requires `reviewed === true` + reviewer evidence ref — PASS.
- Retrieval sources can always be cited: every item carries `sourcePath` + `contentHash`; scope boundary enforced — PASS.

## Known Limits

- The governed live-path CLI (`workbench pipeline run` against the real `devflow-runtime` process with a live agent) is exercised in unit/CLI tests with stub Runtime doubles, mirroring Level 2's opt-in live field acceptance; a full live agent run remains an opt-in manual acceptance.
- Semantic/vector retrieval is not implemented (recorded deferral with the 15-point gate).
- PDF/Docs/Issue ingestion deferred; Markdown and code first.
