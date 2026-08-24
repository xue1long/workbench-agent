## Summary

<!-- One paragraph: what changed and why. -->

## Trust-boundary impact

The Agent Workbench Runtime enforces three trust boundaries:

1. **DevFlow EventStore is the sole source of truth for governed state.** Workbench `StateStore` rows are rebuildable projections.
2. **Agent output is never trusted** — only evaluator / verifier output with `verifier_version` can become Evidence.
3. **Human approval is mandatory before promotion** (Level 5); auto-promotion is a deliberate deferral.

If this PR touches any of these boundaries, call it out:

- [ ] No impact on trust boundaries.
- [ ] Touches a trust boundary — the level doc explains the gate.

## Affected levels

- [ ] L1 Workspace Core
- [ ] L2 Orchestration
- [ ] L3 Pipeline / Knowledge
- [ ] L4 Trajectory / Evaluation
- [ ] L5 Evolution / Canary
- [ ] L6 Intelligence
- [ ] L7 Graph / Lab / Packages
- [ ] Docs / tooling only

## Test discipline

- [ ] Failing test added first, then implementation, then `npm test` passes locally.
- [ ] `npm run ci` is green (syntax + format + version + tests + release-dry-run).
- [ ] If this is a `feat:` or `fix:`, the matching module in `tests/*.test.mjs` covers the new behavior.
- [ ] If this touches a level's acceptance surface, `docs/level-N-acceptance.md` is updated.

## Commit hygiene

- [ ] Commit messages follow Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`, `perf:`).
- [ ] Commit subject ≤ 72 chars, imperative mood.
- [ ] No raw prompt / stdout / stderr in any persisted row.

## Dependency impact

- [ ] No runtime npm dependency added.
- [ ] Adds a dev npm dependency (justification in the PR body).
- [ ] Adds a runtime npm dependency — **stop, governance decision required.**

## Reviewer checklist

- [ ] The change passes `npm run ci`.
- [ ] No Level 2 / 5 / 6 / 7 acceptance doc was silently invalidated.
- [ ] New CLI commands show up in `node src/workbench.mjs --help`.
- [ ] If a `.workbench/*` artifact is touched, a test that round-trips through `runTaskRun` / `runPipelineRun` exists.
