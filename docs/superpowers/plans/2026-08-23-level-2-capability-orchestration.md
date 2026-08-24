# Level 2 Capability Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add validated orchestration to Workspace Runtime and close every governed source change through DevFlow Runtime's Action, trusted Evidence, EventStore, recovery, and Decision contracts.

**Architecture:** Model orchestration as a validated DAG whose nodes declare capability and structured acceptance requirements. A small workflow executor schedules ready nodes and delegates work through injected planner/invoker adapters; routing remains a pure deterministic function over the existing Agent registry. `AuditLog`/`StateStore` retain redacted orchestration projections, while DevFlow EventStore is authoritative for governed Intent, Action, Evidence, State, recovery, and Decision. Agents edit only a temporary Git worktree; Workbench converts the candidate diff into a version-bound Action Proposal and the stable `devflow-runtime` file protocol is the only path that may apply it to the governed workspace.

**Tech Stack:** Node.js 20+ ESM, built-in`node:test`, existing JSONL projection store/AuditLog, and a pinned Python 3.11 DevFlow Runtime invoked through UTF-8 Intent YAML and Action JSON files; no new Node runtime dependency.

**Spec:** `C:\Users\HP\OneDrive\007 - 个人笔记\000 Inbox\2026-08-23 Agent Workbench — Level 2 至 Level 7 实施方案.md`

## Global Constraints

- Existing CLI commands and 186 tests remain compatible.
- Existing environment/config mutations use the existing Apply boundary outside governed sessions. Governed source-code mutations use only the DevFlow Action Gateway reached through Task 7's adapter.
- DAG validation, routing scores, retry limits, dependency state, and acceptance results are deterministic code.
- Planner and Agent invoker adapters are injected; Core does not import an LLM SDK.
- Level 2 persists no raw prompts, context, stdout, or stderr. Workbench projections contain hashes, byte counts, safe summaries, paths, and Evidence Claim metadata only.
- DevFlow EventStore is the sole source of truth for governed state. Workbench `AuditLog`/`StateStore` are disposable, rebuildable observability projections and cannot authorize mutation or completion.
- Agent/planner output is untrusted. Only Runtime/Verifier may turn an `EvidenceClaim` into trusted Evidence carrying provenance and `verifier_version`.
- Bind every governed Action to `session_id`, `intent_version`, `policy_version`, `state_revision`, and `idempotency_key`. A single Action targets one to five workspace-contained files.
- Workflow execution success never implies final completion. Only a valid Runtime response with `decision.kind === 'finish'` and valid EventStore integrity maps to `COMPLETED`; corrupt or uncertain state maps to `QUARANTINED` and halts further Actions.
- Default execution is sequential (`concurrency: 1`); bounded parallelism is opt-in.
- No debate, voting, learned router, distributed queue, vector store, or UI workflow editor.
- A live task may run only after the Git repository, callable-provider, and Runtime compatibility gates pass.
- Level 2 governed changes support only creation or replacement of one to five UTF-8 text files. Binary edits, deletion, and rename are rejected before Runtime invocation.
- Human approval is enforced by the trusted Workbench control plane: `DevflowRuntimeAdapter.run` requires an approved receipt recorded before spawn. Agent processes receive only their worktree and cannot call the adapter against the governed workspace.

---

## Phase 0: Execution readiness gate

Current observation on 2026-08-23: `git rev-parse --show-toplevel` fails, Claude CLI is absent, and the packaged Codex desktop executable cannot be launched as a CLI subprocess. These are external prerequisites, not code defects.

**Allowed work by gate:**

- Phase 0 Runtime compatibility fixes may start immediately in `D:\5-Project\20260819\devflow-runtime`.
- After`npm test` and the Repository gate pass, implement Tasks 1–6 in an isolated Workbench worktree using deterministic fixtures.
- Start Tasks 7–12 only after the Repository, Provider, and Runtime compatibility gates all pass; before then, do not run a live Agent against the governed workspace or claim Level 2 completion.

- [ ] Run`npm test`; expected: 186 or more tests and zero failures.
- [ ] Run `git rev-parse --show-toplevel`.
- [ ] If Git detection fails, stop and ask the user to choose between initializing this directory and attaching it to an existing repository. Do not initialize automatically.
- [ ] After Git is available, record `git status --short`, current commit, Node version, OS, and unrelated user changes in `docs/level-2-acceptance.md`.
- [ ] Configure one callable Agent provider and run its harmless no-change probe inside a temporary Git worktree.
- [ ] Record the provider command name and version, but never its credentials or raw probe prompt/output.
- [ ] In `D:\5-Project\20260819\devflow-runtime`, record `.venv\Scripts\python.exe --version` and require Python 3.11+; run `& '.\.venv\Scripts\python.exe' -m pytest -q` and require zero failures. Do not assume `py` exists.
- [ ] Fix the five stale authorization-time tests by deriving valid authorization timestamps from the test's current UTC time; keep the explicit expired-authorization test negative.
- [ ] Add a Runtime regression test that starts and finishes Session A, then starts Session B in the same workspace and proves B begins at its own revision with only its own Intent, Evidence, blocking reasons, and terminal state. Fix `RuntimeKernel.observe`, `status`, recovery, and ActionGateway reduction at the shared event-selection boundary by filtering events on `aggregate_id == session_id`.
- [ ] Extend `protocol/cli.py::load_config` to accept `test_command` as a literal string array and pass it into `RuntimeKernel(test_command=...)`. Add a protocol test whose required `test` acceptance finishes only when the configured command succeeds and halts when it fails.
- [ ] In a temporary Git fixture, enable Runtime with `enabled: true` and `test_command: [npm, test]`; prove UTF-8 full-content single/multi-file Actions, two isolated consecutive sessions, `status`, `run`, and `recover`. Do not use the personal `dfr` wrapper.

**Runtime compatibility files:**

- Modify: `D:\5-Project\20260819\devflow-runtime\src\devflow_runtime\runtime\kernel.py`
- Modify: `D:\5-Project\20260819\devflow-runtime\src\devflow_runtime\runtime\action_gateway.py`
- Modify: `D:\5-Project\20260819\devflow-runtime\src\devflow_runtime\protocol\cli.py`
- Modify: `D:\5-Project\20260819\devflow-runtime\tests\test_kernel.py`
- Modify: `D:\5-Project\20260819\devflow-runtime\tests\test_protocol_cli.py`
- Modify only the stale-time fixtures in `tests\test_effect_gateway.py`, `tests\test_operations.py`, and `tests\integration\test_final_gate.py`.

Run focused Runtime verification first:

```powershell
& '.\.venv\Scripts\python.exe' -m pytest -q tests/test_kernel.py tests/test_protocol_cli.py tests/test_effect_gateway.py tests/test_operations.py tests/integration/test_final_gate.py
```

Then run `& '.\.venv\Scripts\python.exe' -m pytest -q`. Commit this compatibility change in the DevFlow Runtime repository before beginning Workbench Task 7; do not mix the two repositories in one commit.

**Completion criterion:** Git commands, provider no-change invocation, the full DevFlow Runtime suite, configured test Evidence, correct multi-file shape, and two-session protocol isolation all succeed. This unlocks Tasks 7–12. Repository readiness alone unlocks Tasks 1–6; it does not unlock live execution or the Level 2 phase gate.

**Execution context rule:** The controller gives a worker only this header, Global Constraints, Phase 0 state, and the current Task section. The controller retains the full file and performs the cross-task interface review between tasks.

---

### Task 1: Add the Task and DAG contract

**Files:**
- Create: `core/task-graph.mjs`
- Create: `tests/task-graph.test.mjs`

**Interfaces:**
- Produces: `TaskGraphError`.
- Produces: `createTask(input) -> Task`.
- Produces: `createTaskGraph({ task, nodes }) -> TaskGraph`.
- Produces: `canonicalJson(value) -> string` with recursively sorted object keys and preserved array order.
- Produces: `topologicalOrder(graph) -> string[]`.
- Produces: `readyNodeIds(graph, completedIds, runningIds, failedIds) -> string[]`.

Task shape:

```js
{
  id: 'task-1', goal: 'Add OAuth login', context: {},
  priority: 'normal', risk: 'medium',
  budget: { maxCostUsd: 2, maxTokens: 100000 },
  deadline: '2026-08-24T00:00:00.000Z'
}
```

Node shape:

```js
{
  id: 'backend', goal: 'Implement OAuth callback',
  dependencies: ['architecture'], capabilityRequired: 'backend_development',
  requiredTools: ['git'],
  acceptanceCriteria: [{ id: 'backend-tests', verifierRef: 'test', required: true }],
  kind: 'work',
  maxAttempts: 1, maxReviewRounds: 0
}
```

- [ ] **Step 1: Write failing contract tests**

Cover valid construction, duplicate IDs, missing dependencies, self-dependency, cycles, stable topological order, fan-out readiness, fan-in readiness, failed-dependency blocking, budget/deadline validation, and equal hashes for objects whose keys appear in different insertion order.

```js
test('createTaskGraph rejects cycles', () => {
  assert.throws(() => createTaskGraph({
    task: createTask({ id: 't', goal: 'x' }),
    nodes: [
      { id: 'a', goal: 'a', dependencies: ['b'], capabilityRequired: 'coding', acceptanceCriteria: [{ id: 'a-diff', verifierRef: 'diff', required: true }] },
      { id: 'b', goal: 'b', dependencies: ['a'], capabilityRequired: 'coding', acceptanceCriteria: [{ id: 'b-diff', verifierRef: 'diff', required: true }] },
    ],
  }), (error) => error.code === 'TASK_GRAPH_CYCLE');
});
```

- [ ] **Step 2: Verify the test fails**

Run:`node --test tests/task-graph.test.mjs`

Expected: FAIL because `core/task-graph.mjs` does not exist.

- [ ] **Step 3: Implement the minimal immutable contract**

Use plain objects, arrays, `Map`, `Set`, and Kahn's algorithm. Freeze returned task, node, and graph objects. Reject empty goals, invalid IDs, duplicate acceptance IDs, verifier refs outside `diff|scope|test|budget|dependency|architecture|audit`, empty acceptance criteria, missing dependencies, cycles, non-positive attempt limits, invalid deadlines, and negative budgets. Compute `task.inputHash` and each node's `definitionHash` with SHA-256 over canonical JSON; these hashes govern safe result reuse after replan. User-facing prose may be retained separately, but every acceptance crossing the governance boundary must have `{ id, verifierRef, required }`.

- [ ] **Step 4: Verify focused and full suites**

Run:`node --test tests/task-graph.test.mjs`

Expected: PASS.

Run:`npm test`

Expected: all existing and new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add core/task-graph.mjs tests/task-graph.test.mjs
git commit -m "feat: add validated task graph"
```

### Task 2: Standardize the Workbench observability projection

**Files:**
- Modify: `core/audit.mjs`
- Modify: `core/store.mjs`
- Modify: `tests/store_audit.test.mjs`

**Interfaces:**
- Consumes: existing `AuditLog.record(event)` and `StateStore.recordAudit(event)`.
- Produces: `AuditLog.taskCreated({ taskId, runId, goal })`.
- Produces: `AuditLog.taskPlanned({ taskId, runId, nodeIds })`.
- Produces: `AuditLog.agentSelected({ taskId, runId, nodeId, agentId, score, reasons })`.
- Produces: `AuditLog.nodeStarted/nodeFinished/nodeRetried/nodeFailed(...)`.
- Produces: `AuditLog.taskExecutionSucceeded/taskFailed/taskHalted/taskQuarantined(...)`.
- Produces: `StateStore.listAudit({ runId, type } = {})` while preserving `listAudit()` compatibility.
- Does not produce governed State, trusted Evidence, or final Decision; those are read from DevFlow Runtime in Task 7.

- [ ] **Step 1: Write failing event tests**

```js
test('orchestration events retain run identity and redact context', () => {
  const event = log.nodeStarted({
    taskId: 't1', runId: 'r1', nodeId: 'n1',
    context: { token: 'do-not-store' },
  });
  assert.equal(event.runId, 'r1');
  assert.equal(event.context, undefined);
  assert.match(event.contextDigest.sha256, /^[a-f0-9]{64}$/);
  assert.ok(event.contextDigest.bytes > 0);
});
```

Also prove that filtering by `runId` returns only that run, a corrupt projection line is reported and can be skipped without changing governed state, and raw fields named `prompt`, `context`, `stdout`, or `stderr` are replaced by `{ sha256, bytes }` metadata before persistence. Include a secret embedded inside a non-sensitive free-text field and prove the raw text is absent from the JSONL file. Add a separate adapter-level test in Task 7 proving that corrupt DevFlow EventStore integrity is never skipped and forces `QUARANTINED`/`halt`.

- [ ] **Step 2: Verify the tests fail**

Run:`node --test tests/store_audit.test.mjs`

Expected: FAIL because the orchestration projection wrappers do not exist.

- [ ] **Step 3: Add wrappers without creating a second event bus**

Keep the audit table as the single Workbench observability projection; do not add a trajectory table or a second governed event bus. Store uppercase `type` values: `TASK_CREATED`, `TASK_PLANNED`, `AGENT_SELECTED`, `AGENT_STARTED`, `TOOL_CALLED`,`NODE_EXECUTION_SUCCEEDED`, `TASK_RETRIED`, `PLAN_REVISED`, `CHANGESET_CREATED`, `ACTION_PROPOSED`, `RUNTIME_DECIDED`, `TASK_FAILED`, `TASK_HALTED`, and `TASK_QUARANTINED`. Preserve existing `kind` events for compatibility. Route every wrapper through `record()`. Add `digestText(text)` using`node:crypto` SHA-256 and apply a persistence sanitizer inside `record()` that replaces fields named `prompt`, `context`, `stdout`, or `stderr` with `<field>Digest: { sha256, bytes }` before ordinary key-based redaction. Document in code and tests that this table is rebuildable telemetry: it cannot authorize a change, create trusted Evidence, or declare final completion.

- [ ] **Step 4: Verify focused and full suites**

Run:`node --test tests/store_audit.test.mjs`

Run:`npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/audit.mjs core/store.mjs tests/store_audit.test.mjs
git commit -m "feat: persist orchestration events"
```

### Task 3: Execute a sequential DAG

**Files:**
- Create: `core/workflow-runtime.mjs`
- Create: `tests/workflow-runtime.test.mjs`

**Interfaces:**
- Consumes: `TaskGraph`, `readyNodeIds`, and optional `AuditLog`.
- Produces: `WorkflowRuntimeError`.
- Produces: `executeWorkflow(graph, runNode, options) -> Promise<WorkflowReport>`.

`runNode(node, context)` returns untrusted execution output:

```js
{ success: true, output: {}, evidenceClaims: [], cost: 0, usage: {}, message: '' }
```

`WorkflowReport` contains `taskId`, `runId`, `executionStatus`, `startedAt`, `finishedAt`,`nodes`, `cost`, and `evidenceClaims`. `executionStatus` is `EXECUTION_SUCCEEDED`, `FAILED`, or `HALTED`; this type deliberately has no `COMPLETED` value and carries no final governance authority.

- [ ] **Step 1: Write failing sequential execution tests**

Prove stable topological execution, independent result capture, dependency blocking, empty graph completion, thrown-handler normalization, and event emission.

```js
test('failed nodes block dependants', async () => {
  const called = [];
  const report = await executeWorkflow(graph, async (node) => {
    called.push(node.id);
    return { success: node.id !== 'architecture', evidenceClaims: [] };
  });
  assert.deepEqual(called, ['analysis', 'architecture']);
  assert.equal(report.nodes.backend.status, 'BLOCKED');
  assert.equal(report.executionStatus, 'FAILED');
});
```

- [ ] **Step 2: Verify failure**

Run:`node --test tests/workflow-runtime.test.mjs`

Expected: FAIL because the runtime does not exist.

- [ ] **Step 3: Implement concurrency-one scheduling**

Keep all state local to one execution. Generate `runId` with `crypto.randomUUID()` unless injected for tests. Convert thrown errors and malformed handler results into failed node results. Do not retry yet.

- [ ] **Step 4: Verify focused and full suites**

Run:`node --test tests/workflow-runtime.test.mjs`

Run:`npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/workflow-runtime.mjs tests/workflow-runtime.test.mjs
git commit -m "feat: execute sequential task workflows"
```

### Task 4: Add retry, fallback, and reviewer-loop limits

**Files:**
- Modify: `core/workflow-runtime.mjs`
- Modify: `tests/workflow-runtime.test.mjs`

**Interfaces:**
- Extends node with optional `maxAttempts` defaulting to `1` and optional `fallbackAgentIds` defaulting to `[]`.
- Extends `runNode` context with `{ runId, attempt, agentId, previousResult }`.
- Extends `executeWorkflow` options with `selectFallback(node, failedResult, attemptedAgentIds) -> string | null` and `replan({ graph, report, failedReviewNode }) -> TaskGraph | null`.
- Reviewer nodes use `kind: 'review'`. A failed reviewer does not simply retry itself: it may request one revised acyclic graph containing explicit correction, verification, and review nodes.

- [ ] **Step 1: Write failing recovery tests**

Prove success on second attempt, retry exhaustion, fallback Agent selection, no Agent repeated after fallback, reviewer correction flow, one callback-driven replan, and safe completed-node reuse.

```js
test('retry never exceeds maxAttempts', async () => {
  let calls = 0;
  const report = await executeWorkflow(graphWith({ maxAttempts: 2 }), async () => {
    calls += 1;
    return { success: false, evidenceClaims: [] };
  });
  assert.equal(calls, 2);
  assert.equal(report.executionStatus, 'FAILED');
});
```

- [ ] **Step 2: Verify failure**

Run:`node --test tests/workflow-runtime.test.mjs`

Expected: FAIL on missing retry/fallback behavior.

- [ ] **Step 3: Implement bounded recovery**

Use loops with explicit numeric ceilings. Persist every attempt and routing change. Replan may be called once per run and produces `graphRevision: 2`. Validate the replacement graph before continuing. Reuse an earlier completed result only when`node.id` and`node.definitionHash` are unchanged; otherwise schedule the node again. Never reuse a failed, blocked, running, or side-effecting result whose verification evidence is missing. A failed reviewer must produce a graph with `correction → verification → review`; reject a revised graph that omits any of those three kinds.

- [ ] **Step 4: Verify focused and full suites**

Run:`node --test tests/workflow-runtime.test.mjs`

Run:`npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/workflow-runtime.mjs tests/workflow-runtime.test.mjs
git commit -m "feat: add bounded workflow recovery"
```

### Task 5: Add bounded parallel fan-out and fan-in

**Files:**
- Modify: `core/workflow-runtime.mjs`
- Modify: `tests/workflow-runtime.test.mjs`

**Interfaces:**
- Extends `executeWorkflow` options with integer `concurrency`, default `1`, minimum `1`, maximum `16`.
- Preserves deterministic scheduling order by topological position and node ID.

- [ ] **Step 1: Write failing concurrency tests**

Use deferred promises to prove two independent nodes overlap at `concurrency: 2`, never exceed the bound, fan-in waits for all dependencies, and one branch failure blocks only its dependants.

- [ ] **Step 2: Verify failure**

Run:`node --test tests/workflow-runtime.test.mjs`

Expected: FAIL because execution remains sequential.

- [ ] **Step 3: Implement a small in-process scheduler**

Use `Promise.race` over a `Map` of running promises. Do not add a queue dependency. Dispatch ready nodes until the bound is full, then wait for one completion and recalculate readiness.

- [ ] **Step 4: Verify focused and full suites**

Run:`node --test tests/workflow-runtime.test.mjs`

Run:`npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/workflow-runtime.mjs tests/workflow-runtime.test.mjs
git commit -m "feat: support bounded parallel workflows"
```

### Task 6: Add deterministic Agent routing

**Files:**
- Create: `core/capabilities.mjs`
- Create: `core/agent-router.mjs`
- Create: `tests/capabilities.test.mjs`
- Create: `tests/agent-router.test.mjs`
- Modify: `core/agents.mjs`
- Modify: `tests/config_models.test.mjs`

**Interfaces:**
- Produces: `createCapability(input) -> CapabilityDefinition` with `{ id, category, description, requiredTools, requiredContext }`.
- Produces: `listCapabilities(definitions) -> CapabilityDefinition[]` sorted by ID.
- Produces: `agentsForCapability(capabilityId, agents) -> AgentDefinition[]` sorted by Agent ID.
- Consumes: existing `AgentRegistry.list()` and Agent `capabilities` arrays.
- Produces: `rankAgents(requirement, agents, options) -> RankedAgent[]`.
- Produces: `selectAgent(requirement, agents, options) -> RankedAgent`.
- Produces: `deriveRouterMetrics(events, agentIds) -> Record<string, RouterMetrics>` using only terminal task/node events from the current schema version.
- `RankedAgent` contains `{ agent, score, reasons }`.
- Extends `AgentDefinition` with `tools: string[]`, `maxRisk: 'low'|'medium'|'high'`, and `maxContextTokens: number`; all serialize through `toJSON()` and merge through `applyManifest()`.
- `requirement` contains `{ capabilityRequired, requiredTools, risk, budget, estimatedContextTokens }`.
- `options.metrics[agentId]` contains normalized `{ historicalSuccess, availability, cost, latency }` values in `[0,1]`.

Default normalized weights:

```js
{
  capability: 0.40,
  historicalSuccess: 0.20,
  availability: 0.15,
  cost: 0.10,
  latency: 0.05,
  toolCompatibility: 0.10,
}
```

- [ ] **Step 1: Write failing routing tests**

Prove capability schema validation, duplicate capability rejection, stable listing/query, exact capability filtering, unavailable Agent removal, missing-tool removal, risk ceiling enforcement, budget hard rejection, context-capacity hard rejection, stable tie-breaking by Agent ID, normalized score bounds, explanation output, no mutation of inputs, and neutral metrics for Agents with no compatible historical events.

```js
test('selectAgent explains a deterministic capability match', () => {
  const selected = selectAgent(
    { capabilityRequired: 'debugging', requiredTools: [], risk: 'low', budget: null, estimatedContextTokens: 8000 },
    registry.list(),
    { availability: { codex: 1, 'claude-code': 1 } },
  );
  assert.equal(selected.agent.id, 'claude-code');
  assert.ok(selected.reasons.some((reason) => reason.includes('debugging')));
});
```

- [ ] **Step 2: Verify failure**

Run:`node --test tests/capabilities.test.mjs tests/agent-router.test.mjs`

Expected: FAIL because the capability helpers and router do not exist.

- [ ] **Step 3: Implement pure weighted scoring**

Implement capability definitions as frozen plain objects and pure query functions; do not add a registry service or database. Apply hard filters first: known capability, Agent mapping, required tools, `status !== 'DISABLED'`, risk ceiling, availability greater than zero, estimated cost within budget, and `estimatedContextTokens <= maxContextTokens`. Score remaining Agents using the declared weights. `deriveRouterMetrics` computes success rate, median cost, and median latency only from matching schema/task classes, then normalizes cost/latency across current candidates. Missing historical success, cost, or latency uses `0.5` and records that default in `reasons`; missing availability is `0` and excludes the Agent. Keep built-in capabilities backward compatible and give built-ins explicit tools/context ceilings.

- [ ] **Step 4: Verify focused and full suites**

Run:`node --test tests/capabilities.test.mjs tests/agent-router.test.mjs tests/config_models.test.mjs`

Run:`npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/capabilities.mjs core/agent-router.mjs core/agents.mjs tests/capabilities.test.mjs tests/agent-router.test.mjs tests/config_models.test.mjs
git commit -m "feat: route tasks with deterministic scoring"
```

### Task 7: Prepare candidate changes and integrate the DevFlow Runtime protocol

**Files:**
- Create: `core/change-sandbox.mjs`
- Create: `adapters/devflow-runtime.mjs`
- Create: `tests/change-sandbox.test.mjs`
- Create: `tests/devflow-runtime.test.mjs`
- Create: `config/runtime.yaml`

**Interfaces:**
- Produces: `createChangeSandbox({ repoRoot, runId, runner, tempRoot }) -> Promise<ChangeSandbox>`.
- Produces: `collectChangeSet(sandbox, { runner }) -> Promise<ChangeSet>`.
- Produces: `buildGovernedFiles({ task, node, changeSet, runtimeState, approval }) -> { intentPath, actionPath, approvalDigest }`.
- Produces: `DevflowRuntimeAdapter.status({ workspace }) -> Promise<RuntimeStatus>`.
- Produces: `DevflowRuntimeAdapter.run({ workspace, intentPath, actionPath, sessionId, approval }) -> Promise<GovernedResult>`; it refuses unless `approval.approved === true`.
- Produces: `DevflowRuntimeAdapter.recover({ workspace, sessionId }) -> Promise<RecoveryResult>`.
- `ChangeSet` contains `{ runId, baseCommit, patchPath, patchSha256, changedFiles, edits, sandboxPath }`; `edits` contains `{ path, content, expectedDigest, changeType }`, where `content` is complete new UTF-8 text held only in temporary memory/files and `changeType` is `create|replace`. Patch/content bytes never enter a Workbench event.
- `GovernedResult` contains `{ sessionId, stateRevision, actionStatus, blockingReasons, evidenceIds, decision, eventStoreIntegrity, error }`.

`buildGovernedFiles` writes UTF-8 files and emits an Action with exactly these bindings:

```js
{
  id, kind: 'file_edit', actor, target_paths,
  payload: { multi_file: { edits: [{ path, patch: completeNewText, expected_digest }] } },
  intent_version, policy_version, state_revision, idempotency_key
}
```

- [ ] **Step 1: Write failing sandbox and protocol tests**

Use temporary Git repositories, an injected argument-array runner for unit tests, and the real stable CLI for the opt-in integration test. Prove detached worktree creation, clean-tree no-op, path/symlink escape rejection, deterministic patch hashing, complete UTF-8 content round-trip, exact `file_edit`/`payload.multi_file.edits` shape, one-to-five-file enforcement, binary/deletion/rename rejection, explicit approval before spawn, valid verifier refs, required version/revision/idempotency fields, `shell: false`, JSON-only output parsing, and rejection of malformed output. Prove that the adapter never runs `git apply` or writes governed target files itself.

```js
test('corrupt EventStore forbids completion', async () => {
  const result = await adapter.run({ workspace, intentPath, actionPath });
  assert.equal(result.eventStoreIntegrity.valid, false);
  assert.equal(result.decision.kind, 'halt');
  assert.equal(result.finalStatus, 'QUARANTINED');
});
```

Also prove unauthorized paths, stale `state_revision`, missing required verifier evidence, and uncertain recovery return `halt`/`QUARANTINED`, never `finish`. A candidate touching more than five files is rejected before invocation with `ACTION_FILE_LIMIT`; multi-Action batching is deliberately deferred.

- [ ] **Step 2: Verify failure**

Run:`node --test tests/change-sandbox.test.mjs tests/devflow-runtime.test.mjs`

Expected: FAIL because the sandbox collector and adapter do not exist.

- [ ] **Step 3: Implement the minimum adapter**

Use `git worktree add --detach <sandboxPath> <baseCommit>` with `shell: false`. Collect `git diff --binary --no-ext-diff` only to compute audit metadata, then inspect `git diff --name-status` and reject delete, rename, binary, invalid UTF-8, or more than five changed files. For each accepted path, read the complete new text from the sandbox as `FileEdit.patch` and compute `expected_digest` from the governed workspace preimage immediately before file generation. Emit `kind: file_edit` with `payload.multi_file.edits`; validate acceptance refs against `diff|scope|test|budget|dependency|architecture|audit`. Write Intent YAML and Action JSON under the run's temporary directory with explicit UTF-8 encoding. Create `config/runtime.yaml` as `enabled: false` plus `test_command: [npm, test]`; tests enable only their temporary fixture, and users must opt in explicitly. Record the approval receipt projection before spawning. Spawn only the stable forms `devflow-runtime --workspace <repoRoot> status`, `... run --intent <file> --action <file> [--session <id>]`, and `... recover --session <id>` with literal argument arrays and parse bounded JSON output. Do not call the personal `dfr` wrapper, duplicate ScopeVerifier/ActionGateway/DecisionEngine, apply a Git patch directly, or silently recover invalid EventStore data. Map invalid integrity or uncertain recovery to `QUARANTINED`; map `finish` only when integrity is valid.

- [ ] **Step 4: Verify focused and full suites**

Run:`node --test tests/change-sandbox.test.mjs tests/devflow-runtime.test.mjs`

Run:`npm test`

Expected: PASS.

- [ ] **Step 5: Commit after Phase 0 passes**

```powershell
git add core/change-sandbox.mjs adapters/devflow-runtime.mjs tests/change-sandbox.test.mjs tests/devflow-runtime.test.mjs config/runtime.yaml
git commit -m "feat: govern source changes with devflow runtime"
```

### Task 8: Add a safe process Agent invoker

**Files:**
- Create: `adapters/process-agent.mjs`
- Create: `tests/process-agent.test.mjs`
- Modify: `core/agents.mjs`
- Modify: `tests/config_models.test.mjs`

**Interfaces:**
- Extends `AgentDefinition` with optional `invocation: { executable, args, timeoutMs }`.
- Produces: `ProcessAgentError`.
- Produces: `ProcessAgentInvoker.invoke(agent, node, context) -> Promise<AgentResult>`.
- `AgentResult` contains `{ success, exitCode, signal, durationMs, stdoutDigest, stderrDigest, changedFiles, evidenceClaims, cost, usage, message }`. `evidenceClaims` has no `trusted` field and cannot satisfy a required acceptance by itself.

- [ ] **Step 1: Write failing invocation tests**

Use a Node fixture process, never a network model. Prove `shell: false`, prompt delivery by temporary file or stdin rather than command-line interpolation, working-directory confinement to `sandboxPath`, timeout with `AbortController`, output byte limit, non-zero exit normalization, cancellation, and digest-only persistence.

```js
test('invoker refuses a cwd outside the change sandbox', async () => {
  await assert.rejects(
    () => invoker.invoke(agent, node, { sandboxPath, cwd: repoRoot }),
    (error) => error.code === 'AGENT_CWD_OUTSIDE_SANDBOX',
  );
});
```

- [ ] **Step 2: Verify failure**

Run:`node --test tests/process-agent.test.mjs`

Expected: FAIL because the invoker does not exist.

- [ ] **Step 3: Implement provider-neutral invocation**

Validate the configured executable and literal argument array; substitute only the exact placeholders `{promptFile}`, `{outputFile}`, and `{cwd}` as whole argument values. Spawn with `shell: false`, `windowsHide: true`, bounded stdout/stderr buffers, and an abort timer. Parse the bounded output in memory, return digests and a safe message, then discard raw stdout/stderr. Prompt/output files are temporary and deleted after parsing; only source changes, patch metadata, and declared evidence files survive the run.

- [ ] **Step 4: Verify focused and full suites**

Run:`node --test tests/process-agent.test.mjs tests/config_models.test.mjs`

Run:`npm test`

Expected: PASS.

- [ ] **Step 5: Commit after Phase 0 passes**

```powershell
git add adapters/process-agent.mjs core/agents.mjs tests/process-agent.test.mjs tests/config_models.test.mjs
git commit -m "feat: invoke agents inside change sandboxes"
```

### Task 9: Add a structured planner adapter

**Files:**
- Create: `adapters/process-planner.mjs`
- Create: `tests/process-planner.test.mjs`

**Interfaces:**
- Produces: `ProcessPlannerError`.
- Produces:`new ProcessPlanner({ invoker, agent })`.
- Produces: `ProcessPlanner.plan(task, { sandboxPath, signal }) -> Promise<TaskGraph>`.
- The configured planner receives a prompt file and must write one JSON plan file; stdout is diagnostic only.

- [ ] **Step 1: Write failing planner tests**

Use a Node fixture planner. Prove valid JSON conversion to `TaskGraph`, missing output rejection, malformed JSON rejection, cycle rejection, unknown field rejection, timeout, output size limit, and prompt/output digest events without raw content.

```js
test('planner rejects a cyclic provider response', async () => {
  await assert.rejects(
    () => planner.plan(task, { sandboxPath }),
    (error) => error.code === 'PLANNER_INVALID_GRAPH',
  );
});
```

- [ ] **Step 2: Verify failure**

Run:`node --test tests/process-planner.test.mjs`

Expected: FAIL because the planner adapter does not exist.

- [ ] **Step 3: Implement the structured boundary**

Reuse the safe spawning rules from `ProcessAgentInvoker` through a shared exported `runProcess()` function in `adapters/process-agent.mjs`; do not introduce a second process abstraction. Generate a temporary prompt containing the exact TaskGraph JSON schema and output path. Read at most 1 MiB from the output file, parse JSON, delete the prompt/output files, and pass the parsed value through `createTaskGraph()` before returning.

- [ ] **Step 4: Verify focused and full suites**

Run:`node --test tests/process-planner.test.mjs tests/process-agent.test.mjs`

Run:`npm test`

Expected: PASS.

- [ ] **Step 5: Commit after Phase 0 passes**

```powershell
git add adapters/process-planner.mjs adapters/process-agent.mjs tests/process-planner.test.mjs tests/process-agent.test.mjs
git commit -m "feat: plan tasks through a validated provider boundary"
```

### Task 10: Add the planning and governed orchestration service

**Files:**
- Create: `core/orchestrator.mjs`
- Create: `tests/orchestrator.test.mjs`

**Interfaces:**
- Consumes: `createTask`, `createTaskGraph`, `selectAgent`, `executeWorkflow`, `createChangeSandbox`, `collectChangeSet`, `buildGovernedFiles`, `DevflowRuntimeAdapter`, `AgentRegistry`, `ProcessPlanner`, `ProcessAgentInvoker`, and optional `AuditLog` projection.
- Produces: `planTask(task, planner) -> Promise<TaskGraph>`.
- Produces: `runTask(task, dependencies, { concurrency, approveChangeSet, signal }) -> Promise<GovernedWorkflowReport>`.
- `approveChangeSet(changeSet)` returns `{ approved: boolean, actor: string, reason: string, changeSetSha256: string }`; `buildGovernedFiles` requires `changeSetSha256 === changeSet.patchSha256`, and the full receipt is recorded before Runtime submission.
- `GovernedWorkflowReport` contains the execution report plus `{ sessionId, actionStatus, trustedEvidenceIds, decision, eventStoreIntegrity, finalStatus }`.
- `finalStatus` is `COMPLETED` only for valid integrity plus `decision.kind === 'finish'`; otherwise it is `AWAITING_APPROVAL`, `HALTED`, `FAILED`, or `QUARANTINED`.

Dependencies shape:

```js
{
  planner: { plan: async (task, context) => taskGraph },
  invoker: { invoke: async (agent, node, context) => agentResult },
  changeSandbox: { create, collect },
  runtime: new DevflowRuntimeAdapter(...),
  agents: new AgentRegistry(),
  audit: new AuditLog(...),
}
```

- [ ] **Step 1: Write failing orchestration tests**

Prove planner output validation, one routing decision per attempted node, sandbox-only Agent invocation, Evidence Claim aggregation, deadline cancellation, token/cost budget stop, no eligible Agent failure, unapproved diff preservation without Runtime invocation, approved Action Proposal submission, digest-only projected events, version/session binding, and exact Runtime Decision mapping. Prove that `EXECUTION_SUCCEEDED` without trusted Evidence/`finish` is not `COMPLETED`.

- [ ] **Step 2: Verify failure**

Run:`node --test tests/orchestrator.test.mjs`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the thin composition boundary**

Do not add Team Composer, Supervisor, Workflow Generator, a second Action Gateway, or a second Decision Engine. `planTask` calls the injected planner and validates its graph. `runTask` creates one source-change sandbox, composes routing/execution/invocation, checks deadline and cumulative budget before every attempt, and collects the candidate change. It requests explicit approval, converts the approved candidate and structured acceptances into Intent/Action files, then calls `DevflowRuntimeAdapter.run`. Agent evidence remains Claims; the returned `evidenceIds`, Decision, revision, and integrity become the governance result. Stop further Actions on `halt` or invalid integrity; call `recover` only through the stable protocol and map uncertain state to `QUARANTINED`. Emit `TOOL_CALLED` for Workbench-controlled process and Git calls; provider-internal tool calls are recorded only when a provider adapter supplies structured events. Reviewer/fallback/replan behavior maps onto ordinary DAG/runtime features.

- [ ] **Step 4: Verify focused and full suites**

Run:`node --test tests/orchestrator.test.mjs`

Run:`npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/orchestrator.mjs tests/orchestrator.test.mjs
git commit -m "feat: compose safe live task orchestration"
```

### Task 11: Expose simulation and live execution through the CLI

**Files:**
- Modify: `src/workbench.mjs`
- Modify: `docs/cli.md`
- Modify: `tests/cli.test.mjs`
- Create: `fixtures/tasks/oauth-login.json`

**Interfaces:**
- Produces command: `workbench task validate --file <path>`.
- Produces command: `workbench task simulate --file <path> [--concurrency N]` using deterministic fixture handlers.
- Produces command: `workbench task run --goal <text> [--concurrency N] [--approve-changes]` using configured live planner/invoker adapters.
- `task run` refuses to start without a Git repository, callable provider, green Runtime preflight, and valid EventStore integrity. It always executes in a sandbox; without `--approve-changes`, it retains the candidate patch for review and does not submit an Action.
- Exit codes: `0` Runtime decided `finish` (or deterministic simulation succeeded), `1` failed/halted, `2` invalid command/input, `3` quarantined or EventStore integrity invalid.

- [ ] **Step 1: Add failing CLI tests**

Prove help output, missing arguments, invalid/cyclic simulation graph, concurrency parsing, successful simulation, live-provider/runtime preflight refusal, default no-Action behavior, explicit approval submission, `finish`/`halt`/`quarantined` exit-code mapping, and absence of raw prompt/output in persisted files.

- [ ] **Step 2: Verify failure**

Run:`node --test tests/cli.test.mjs`

Expected: FAIL because `task` commands are unknown.

- [ ] **Step 3: Add the smallest CLI handlers**

Keep the CLI thin. `simulate` loads JSON and uses deterministic handlers. `run` passes the goal unchanged to the configured `ProcessPlanner`, then calls the orchestrator. Render task/run/session IDs, node states, Agent choices, cost, duration, changed files, Evidence Claim metadata, trusted Evidence IDs, patch hash, approval state, state revision, EventStore integrity, Decision, and final status; never render stored credentials or claim that execution success equals completion.

- [ ] **Step 4: Verify focused and full suites**

Run:`node --test tests/cli.test.mjs`

Run:`npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workbench.mjs docs/cli.md tests/cli.test.mjs fixtures/tasks/oauth-login.json
git commit -m "feat: expose simulated and live task execution"
```

### Task 12: Add Level 2 acceptance fixtures and phase gate

**Files:**
- Create: `tests/orchestration_e2e.test.mjs`
- Create: `fixtures/tasks/repository-analysis.json`
- Create: `fixtures/tasks/oauth-login-failure.json`
- Create: `fixtures/live/oauth-demo/package.json`
- Create: `fixtures/live/oauth-demo/src/server.mjs`
- Create: `fixtures/live/oauth-demo/src/index.html`
- Create: `fixtures/live/oauth-demo/tests/oauth.test.mjs`
- Create: `fixtures/live/oauth-demo/README.md`
- Create: `docs/level-2-acceptance.md`

**Interfaces:**
- Consumes the public `runTask` boundary, stable DevFlow Runtime protocol, and CLI.
- Produces nine successful deterministic orchestration fixtures, one correctly classified expected-failure fixture, fail-closed governance fixtures, one bounded live OAuth provider/Runtime scenario, and a machine-readable acceptance summary.

- [ ] **Step 1: Write the end-to-end acceptance tests**

Include sequential, fan-out/fan-in, reviewer success, reviewer correction/replan, retry success, retry exhaustion, fallback success, no eligible Agent, thrown Agent error, and budget/deadline termination. Use deterministic planners/Agents in CI. Mark exactly one orchestration fixture as an expected failure and assert its error code. Add governance cases for unauthorized scope, stale revision, missing verifier, failed configured test command, corrupt EventStore, uncertain recovery, idempotent replay, binary/delete/rename rejection, and the five-file Action ceiling; each negative case must prove no `finish` Decision and no unauthorized mutation. Add one test that completes Session A and then Session B in the same workspace and asserts disjoint Intent, revision, Evidence, blocking reasons, and final Decision.

```js
test('OAuth workflow emits complete evidence and routing history', async () => {
  const report = await runFixture('oauth-login.json');
  assert.equal(report.executionStatus, 'EXECUTION_SUCCEEDED');
  assert.equal(report.finalStatus, 'COMPLETED');
  assert.equal(report.decision.kind, 'finish');
  assert.equal(report.eventStoreIntegrity.valid, true);
  assert.deepEqual(Object.keys(report.nodes), ['analysis', 'architecture', 'backend', 'frontend', 'test', 'review']);
  assert.ok(report.evidenceClaims.some((item) => item.type === 'test'));
  assert.ok(report.trustedEvidenceIds.length > 0);
  assert.ok(eventsFor(report.runId).some((event) => event.type === 'AGENT_SELECTED'));
});
```

- [ ] **Step 2: Verify the tests expose any missing behavior**

Run:`node --test tests/orchestration_e2e.test.mjs`

Expected before final fixes: at least one acceptance assertion fails.

- [ ] **Step 3: Make only the minimal fixes required by acceptance**

Do not introduce new abstractions. Fix behavior in the shared TaskGraph, router, runtime, or orchestrator function where all affected fixtures route through.

- [ ] **Step 4: Run the complete Level 2 gate twice**

Run:

```powershell
npm test
node --test tests/orchestration_e2e.test.mjs
node --test tests/orchestration_e2e.test.mjs
Push-Location 'D:\5-Project\20260819\devflow-runtime'
& '.\.venv\Scripts\python.exe' -m pytest -q
Pop-Location
```

Expected: zero test-runner failures in all four commands; nine orchestration fixtures reach their expected execution state, the expected-failure fixture returns its declared error code, both Sessions remain isolated, and every governance fixture returns the declared `finish`/`halt`/`QUARANTINED` result in both acceptance runs.

- [ ] **Step 5: Run the opt-in live provider gate**

In a fresh temporary Git repository copied from `fixtures/live/oauth-demo`, ask the configured planner/Agent to implement a bounded offline OAuth demonstration: generate an authorization URL, validate callback `state`, render login/success UI, and make`npm test` pass. No real provider credentials or network calls are allowed, and the final candidate may create/replace at most five UTF-8 text files. Verify:

```text
natural-language goal accepted
→ validated TaskGraph created
→ Agent selected with reasons
→ change made only in temporary worktree
→ diff and Evidence Claims collected
→ main fixture unchanged before approval
→ approved candidate converted to version-bound Intent/Action files
→ DevFlow Action Gateway applies the change
→ trusted diff, scope, and configured test Evidence bind every required acceptance
→ EventStore integrity is valid and Decision.kind is finish
→ Workbench projection and Runtime events contain no raw prompt/output
```

If no callable provider exists, record `BLOCKED_PROVIDER_GATE` and do not mark Level 2 complete.

- [ ] **Step 6: Record evidence and commit**

Document Workbench and Runtime test counts, all deterministic outcomes, negative governance outcomes, live provider/version, Runtime commit/protocol version, live result, session/revision, patch hash, trusted Evidence IDs, Decision, EventStore integrity, security scan result, known limits, and the go/no-go decision in `docs/level-2-acceptance.md`.

```bash
git add tests/orchestration_e2e.test.mjs fixtures/tasks fixtures/live docs/level-2-acceptance.md
git commit -m "test: establish level 2 acceptance gate"
```

## Level 2 Definition of Done

- Task graphs are validated and explain dependency failures.
- Sequential, parallel, fan-out, fan-in, review, retry, fallback, and one bounded replan path are covered by executable tests.
- Agent routing is deterministic, explainable, and uses the existing registry.
- Capability definitions, Agent mappings, capability queries, and context-capacity rejection are deterministic and tested.
- Every run has persisted digest-only projections, Evidence Claims, cost, duration, routing decisions, and an execution state.
- Every governed run has version/session bindings, trusted Evidence references, valid EventStore integrity, and a Runtime Decision; only `finish` maps to final completion.
- Existing environment/config mutations use Apply outside governed sessions; governed source changes use sandboxed, explicitly approved Action Proposals and only the DevFlow Action Gateway mutates the workspace.
- Unauthorized scope, stale revision, missing/failed verifier evidence, corrupt EventStore, and uncertain recovery all fail closed and never report completion.
- Two consecutive Runtime sessions in one workspace remain isolated.
- One callable provider passes the bounded offline OAuth planning/execution/Runtime acceptance scenario within the five-file UTF-8 limit.
- CLI behavior is documented and backward compatible.
- The complete test suite and acceptance suite pass twice.

## Deliberate Deferrals

- Planner and Agent invocation remain provider-neutral process adapters rather than SDK integrations.
- Live provider execution remains outside CI but is mandatory for the Level 2 release gate.
- Multi-Action batching is deferred; the first live slice rejects candidates touching more than five files.
- Binary edits, deletion, and rename are deferred until Runtime models those operations explicitly.
- Workbench does not duplicate DevFlow ScopeVerifier, ActionGateway, EventStore/Reducer, Evidence factory, recovery logic, or DecisionEngine.
- No distributed scheduling, durable worker queue, debate, voting, learned routing, workflow editor, or automatic self-improvement.
- Level 3 begins only after the acceptance gate passes.
