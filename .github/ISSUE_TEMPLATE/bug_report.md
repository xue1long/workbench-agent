---
name: Bug report
about: Report wrong behavior in the Workbench Runtime
title: "[bug] "
labels: ["bug", "needs-triage"]
assignees: []
---

## Summary

One-sentence summary of the bug.

## Reproduction

```bash
# Exact command(s) and inputs that produce the bug
node src/workbench.mjs ...
```

## Expected

What you expected to happen.

## Actual

What actually happened. Paste the relevant stderr / stdout.

## Environment

- Node version (`node --version`):
- OS:
- Workbench Runtime version (`grep version package.json`):
- DevFlow Runtime version (if invoked):
- Manifest path / level (L2..L7):

## Trust-boundary impact

Does this affect a governed code path? (i.e. would it cause the orchestrator to bypass the DevFlow Runtime, leak prompt bytes, or skip human approval?)

## Possible cause / logs

Anything else you noticed, or traces from `.workbench/store/*.jsonl`.

## Acceptance suggestion

A failing test or `npm run check` output would be the fastest way to land a fix.
