---
name: Feature request
about: Propose a change to the Workbench Runtime
title: "[feat] "
labels: ["enhancement"]
assignees: []
---

## Problem

What is missing or could work better? Link the relevant level doc or source module.

## Proposed solution

What you want to happen. Include CLI usage or a code sketch if it changes `core/`.

## Trust-boundary impact

Does this change the governed path (L2 / Action Gateway / human approval)?
- [ ] Yes — explain the new code path and the gate that protects it.
- [ ] No.

## Affected levels

- [ ] L2 orchestration
- [ ] L3 pipeline / knowledge
- [ ] L4 trajectory / evaluation
- [ ] L5 evolution / canary
- [ ] L6 intelligence
- [ ] L7 graph / lab / packages

## Alternatives considered

What other shapes could solve this, and why this one is preferred.

## Tests + documentation

- [ ] Failing test in `tests/<module>.test.mjs` (mandatory for `feat`).
- [ ] Per-level acceptance doc updated (`docs/level-N-acceptance.md`).
- [ ] Plan doc updated if this is a new level (`docs/superpowers/plans/2026-08-23-level-N-*.md`).

## Dependency impact

- [ ] Adds a runtime dependency. (This is a governance decision — open an issue first.)
- [ ] Adds a dev dependency.
- [ ] None.
