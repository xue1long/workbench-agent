# M5 Read-only Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a zero-dependency read-only dashboard that reads workspace status through the existing Core API.

**Architecture:** `core/status.mjs` owns manifest loading, adapter detection, and plan assembly. `apps/web/server.mjs` is a thin HTTP adapter exposing `/api/status` and static assets; browser code only renders returned JSON.

**Tech Stack:** Node.js built-ins, native HTML/CSS/JS, `node:test`; no new dependencies.

**Spec:** Approved M5 design in chat: read-only dashboard, same Core API, no adapter logic in UI, accessibility basics, one smoke test.

## Global Constraints

- UI is read-only; no install, sync, restore, Git, shell, or secret resolution from browser code.
- Core remains the only owner of manifest/status/plan assembly.
- Use Node built-ins only; do not add React, bundlers, or runtime dependencies.
- Every mutation remains behind explicit CLI/Core APIs; dashboard endpoints only observe.

### Task 1: Core status API

- [ ] Create `core/status.mjs` exporting `getWorkspaceStatus(manifestPath)`.
- [ ] Return `{ workspace, health, resources, plan }` using existing manifest validation, adapters, observed state, and planner.
- [ ] Keep adapter calls out of browser/server rendering code.

### Task 2: Read-only HTTP dashboard

- [ ] Create `apps/web/server.mjs` using `node:http`.
- [ ] Serve `/` and `/app.js` from `apps/web`.
- [ ] Serve `GET /api/status` from `getWorkspaceStatus`.
- [ ] Return 404 for other paths and JSON 500 errors without stack traces.

### Task 3: Accessible browser view

- [ ] Create `apps/web/index.html` with semantic headings, status region, resource table, and plan list.
- [ ] Create `apps/web/app.js` with native `fetch`, loading/error states, and escaped text rendering.
- [ ] Keep the page read-only and keyboard-accessible.

### Task 4: Verification

- [ ] Add `tests/web.test.mjs` covering status endpoint, static asset serving, and unknown-path 404.
- [ ] Run `node --test tests/web.test.mjs` and `npm test`.