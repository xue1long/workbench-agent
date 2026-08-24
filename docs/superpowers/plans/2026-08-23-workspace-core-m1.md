# Workspace Core M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal runnable Rust CLI that loads `workspace.yaml`, validates the M1 manifest, detects local environment state, computes a desired/current diff, and previews an execution plan without applying changes.

**Architecture:** Keep one zero-dependency Node module and CLI. The module owns manifest parsing, validation, detection, diffing, and planning; the CLI only loads a file and prints the plan. M1 deliberately uses an in-memory observed state and does not install software, open SQLite, or start a UI.

**Tech Stack:** Node.js 20+ built-ins (`node:test`,`node:fs`); no package installation required.

**Spec:** `C:\Users\HP\OneDrive\007 - 个人笔记\000 Inbox\2026-08-23 Agent Workbench — Level 1：Workspace Runtime 开发实施规格.md`, sections 37 and 38 (M1 scope).

## Global Constraints

- M1 stops at `Manifest → State → Diff → Plan`; it does not apply changes.
- Invalid manifests cannot produce a plan.
- Keep external tools behind an adapter-shaped detection boundary.
- Do not implement agents, packages, MCP, sync, restore, or UI in M1.
- Do not persist secrets or print secret values.

### Task 1: Create the failing M1 behavior test

**Files:**
- Create: `src/lib.rs`
- Create: `tests/m1_plan.rs`

**Interfaces:**
- Produces `planFromYaml(yaml, observed) -> { workspace, steps }` in `workbench.mjs`.

- [ ] **Step 1: Write the failing integration test**

```js
test('plan reports update, skip, and install', () => {
  const plan = planFromYaml(yaml, new ObservedState('20', '3.12', null));
  assert.deepEqual(plan.steps.map(({ action, resource, version, previous }) => ({ action, resource, version, previous })), [
    { action: 'UPDATE', resource: 'node', version: '22', previous: '20' },
    { action: 'SKIP', resource: 'python', version: '3.12', previous: null },
    { action: 'INSTALL', resource: 'uv', version: 'latest', previous: null },
  ]);
});
```

- [ ] **Step 2: Run`node --test tests/m1_plan.test.mjs` and confirm it fails because the module/API is missing.**

### Task 2: Implement the minimal manifest, detection, diff, and plan

**Files:**
- Create: `workbench.mjs`
- Create: `tests/m1_plan.test.mjs`
- Create: `fixtures/example-workspace.yaml`

**Interfaces:**
- `ObservedState(node, python, uv)` creates the testable current state.
- `planFromYaml(yaml, observed)` parses and validates required M1 fields and returns ordered step objects.
- CLI command: `workbench plan [--manifest workspace.yaml]`.

- [ ] **Step 1: Use only Node.js built-ins; the fixture parser is intentionally limited to the M1 manifest shape.**
- [ ] **Step 2: Implement the data types and exact diff rules: matching version is `Skip`, differing version is `Update`, missing tool is `Install`.**
- [ ] **Step 3: Implement `workbench plan` with a concise human-readable preview.**
- [ ] **Step 4: Run `cargo test` and verify the M1 test passes.**

### Task 3: Add validation and CLI smoke checks

**Files:**
- Modify: `src/lib.rs`
- Create: `tests/validation.rs`

- [ ] **Step 1: Add a failing test for a manifest missing `workspace.id`.**
- [ ] **Step 2: Implement the smallest validation error for missing required fields and reject invalid YAML.**
- [ ] **Step 3: Run `cargo test` and a CLI preview against the fixture.**

## Verification

Run:

```text
node --test tests/m1_plan.test.mjs
node workbench.mjs plan --manifest fixtures/example-workspace.yaml
```

Expected preview:

```text
Workspace: MyWorkspace
1 UPDATE node 20 → 22
2 SKIP python 3.12
3 INSTALL uv latest
```

Known ceiling: M1 uses injected observed versions rather than probing the host; real adapters belong to M2.
