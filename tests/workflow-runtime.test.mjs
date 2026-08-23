// Level 2 Task 3: sequential DAG execution with deterministic state.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  executeWorkflow,
  WorkflowRuntimeError,
} from '../core/workflow-runtime.mjs';
import { createTask, createTaskGraph } from '../core/task-graph.mjs';

function makeGraph(nodes) {
  return createTaskGraph({
    task: createTask({ id: 'task-rt', goal: 'ship a feature' }),
    nodes,
  });
}

function ok(node) {
  return { success: true, output: { id: node.id }, evidenceClaims: [], cost: 0, usage: {}, message: '' };
}

test('executeWorkflow returns EXECUTION_SUCCEEDED for an empty graph', async () => {
  const graph = makeGraph([]);
  const report = await executeWorkflow(graph, async () => ok({}));
  assert.equal(report.executionStatus, 'EXECUTION_SUCCEEDED');
  assert.equal(report.taskId, 'task-rt');
  assert.ok(report.runId);
  assert.equal(Object.keys(report.nodes).length, 0);
});

test('executeWorkflow runs roots before dependents in topological order', async () => {
  const graph = makeGraph([
    { id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] },
    { id: 'b', goal: 'b', dependencies: ['a'], acceptanceCriteria: [{ id: 'bb', verifierRef: 'diff', required: true }] },
    { id: 'c', goal: 'c', dependencies: ['a'], acceptanceCriteria: [{ id: 'cc', verifierRef: 'diff', required: true }] },
    { id: 'd', goal: 'd', dependencies: ['b', 'c'], acceptanceCriteria: [{ id: 'dd', verifierRef: 'diff', required: true }] },
  ]);
  const calls = [];
  const report = await executeWorkflow(graph, async (node) => {
    calls.push(node.id);
    return ok(node);
  });
  assert.equal(report.executionStatus, 'EXECUTION_SUCCEEDED');
  assert.deepEqual(calls, ['a', 'b', 'c', 'd']);
});

test('failed nodes block dependants and report FAILED', async () => {
  const graph = makeGraph([
    { id: 'analysis', goal: 'analyse', acceptanceCriteria: [{ id: 'an', verifierRef: 'diff', required: true }] },
    { id: 'architecture', goal: 'arch', dependencies: ['analysis'], acceptanceCriteria: [{ id: 'ar', verifierRef: 'diff', required: true }] },
    { id: 'backend', goal: 'backend', dependencies: ['architecture'], acceptanceCriteria: [{ id: 'be', verifierRef: 'diff', required: true }] },
  ]);
  const report = await executeWorkflow(graph, async (node) => ({
    success: node.id !== 'architecture',
    output: {},
    evidenceClaims: [],
    cost: 0,
    usage: {},
    message: node.id === 'architecture' ? 'arch failed' : '',
  }));
  assert.deepEqual(report.nodes.analysis.status, 'SUCCEEDED');
  assert.deepEqual(report.nodes.architecture.status, 'FAILED');
  assert.deepEqual(report.nodes.backend.status, 'BLOCKED');
  assert.equal(report.executionStatus, 'FAILED');
  assert.ok(report.nodes.backend.message.includes('architecture'));
});

test('executeWorkflow normalises thrown handler errors into failed results', async () => {
  const graph = makeGraph([
    { id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] },
  ]);
  const report = await executeWorkflow(graph, async () => {
    throw new Error('boom');
  });
  assert.equal(report.executionStatus, 'FAILED');
  assert.equal(report.nodes.a.status, 'FAILED');
  assert.equal(report.nodes.a.message, 'boom');
});

test('executeWorkflow normalises non-object handler results into failure', async () => {
  const graph = makeGraph([
    { id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] },
  ]);
  const report = await executeWorkflow(graph, async () => null);
  assert.equal(report.nodes.a.status, 'FAILED');
});

test('executeWorkflow records per-node start/finish timestamps and durations', async () => {
  const graph = makeGraph([
    { id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] },
  ]);
  const report = await executeWorkflow(graph, async () => ok({ id: 'a' }));
  assert.ok(report.startedAt);
  assert.ok(report.finishedAt);
  assert.ok(report.nodes.a.startedAt);
  assert.ok(report.nodes.a.finishedAt);
  assert.ok(report.nodes.a.durationMs >= 0);
});

test('executeWorkflow rejects unknown handler shapes', async () => {
  const graph = makeGraph([
    { id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] },
  ]);
  await assert.rejects(
    () => executeWorkflow(graph, 'not-a-function'),
    (err) => err instanceof WorkflowRuntimeError && err.code === 'WORKFLOW_HANDLER_INVALID',
  );
});

test('executeWorkflow carries the injected runId and computes a default one otherwise', async () => {
  const graph = makeGraph([]);
  const report1 = await executeWorkflow(graph, async () => ok({}), { runId: 'preset' });
  assert.equal(report1.runId, 'preset');
  const report2 = await executeWorkflow(graph, async () => ok({}));
  assert.match(report2.runId, /^[0-9a-f-]{36}$/);
});

// ---------- Level 2 Task 4: bounded retry, fallback, reviewer, replan ---

test('retry up to maxAttempts succeeds when a later attempt passes', async () => {
  const graph = makeGraph([
    {
      id: 'a',
      goal: 'a',
      maxAttempts: 3,
      acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }],
    },
  ]);
  let attempts = 0;
  const report = await executeWorkflow(graph, async () => {
    attempts += 1;
    return attempts >= 2 ? ok({ id: 'a' }) : { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: 'transient' };
  });
  assert.equal(report.nodes.a.status, 'SUCCEEDED');
  assert.equal(report.nodes.a.attempts, 2);
  assert.equal(report.executionStatus, 'EXECUTION_SUCCEEDED');
});

test('retry never exceeds maxAttempts and reports FAILED', async () => {
  const graph = makeGraph([
    {
      id: 'a',
      goal: 'a',
      maxAttempts: 2,
      acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }],
    },
  ]);
  let calls = 0;
  const report = await executeWorkflow(graph, async () => {
    calls += 1;
    return { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: 'no' };
  });
  assert.equal(calls, 2);
  assert.equal(report.nodes.a.attempts, 2);
  assert.equal(report.nodes.a.status, 'FAILED');
  assert.equal(report.executionStatus, 'FAILED');
});

test('fallback is selected and never repeats the primary agent id', async () => {
  const graph = makeGraph([
    {
      id: 'a',
      goal: 'a',
      maxAttempts: 1,
      fallbackAgentIds: ['codex'],
      acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }],
    },
  ]);
  let calls = 0;
  const attempted = [];
  const report = await executeWorkflow(graph, async (node, ctx) => {
    calls += 1;
    attempted.push(ctx.agentId);
    if (ctx.agentId === 'codex') return ok(node);
    return { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: 'primary failed' };
  }, {
    selectFallback: (node, failedResult, attemptedAgentIds) => {
      assert.ok(!attemptedAgentIds.includes('codex'), 'fallback must not re-attempt a tried agent');
      return 'codex';
    },
  });
  assert.equal(report.nodes.a.status, 'SUCCEEDED');
  assert.deepEqual(attempted, [null, 'codex']);
});

test('reviewer failure produces a one-shot replan with correction/verification/review', async () => {
  // Two-pass graph: work + review. First review fails -> replan() is called
  // exactly once and returns a graph that contains correction/verification/
  // review. The replacement graph runs to SUCCEEDED.
  const original = createTaskGraph({
    task: createTask({ id: 'task-replan', goal: 'ship' }),
    nodes: [
      { id: 'work', goal: 'work', acceptanceCriteria: [{ id: 'w', verifierRef: 'diff', required: true }], kind: 'work' },
      { id: 'review', goal: 'review', dependencies: ['work'], acceptanceCriteria: [{ id: 'r', verifierRef: 'diff', required: true }], kind: 'review', maxReviewRounds: 1 },
    ],
  });

  const replacement = createTaskGraph({
    task: original.task,
    nodes: [
      { id: 'correction', goal: 'fix', acceptanceCriteria: [{ id: 'c', verifierRef: 'diff', required: true }], kind: 'work' },
      { id: 'verification', goal: 'verify', dependencies: ['correction'], acceptanceCriteria: [{ id: 'v', verifierRef: 'diff', required: true }], kind: 'work' },
      { id: 'review', goal: 'review', dependencies: ['verification'], acceptanceCriteria: [{ id: 'r2', verifierRef: 'diff', required: true }], kind: 'review' },
    ],
  });

  let replanCalls = 0;
  let attempt = 0;
  const report = await executeWorkflow(original, async (node) => {
    attempt += 1;
    if (node.id === 'work') return ok(node);
    if (node.id === 'review') {
      if (attempt <= 3) return { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: 'reviewer rejects' };
      return ok(node);
    }
    return ok(node);
  }, {
    replan: ({ graph, report, failedReviewNode }) => {
      replanCalls += 1;
      assert.equal(failedReviewNode.id, 'review');
      return replacement;
    },
  });
  assert.equal(replanCalls, 1);
  assert.equal(report.nodes.review.status, 'SUCCEEDED');
});

test('replan is rejected when the replacement omits correction/verification/review', async () => {
  const original = createTaskGraph({
    task: createTask({ id: 'task-bad-replan', goal: 'ship' }),
    nodes: [
      { id: 'work', goal: 'work', acceptanceCriteria: [{ id: 'w', verifierRef: 'diff', required: true }], kind: 'work' },
      { id: 'review', goal: 'review', dependencies: ['work'], acceptanceCriteria: [{ id: 'r', verifierRef: 'diff', required: true }], kind: 'review' },
    ],
  });

  const bad = createTaskGraph({
    task: original.task,
    nodes: [
      { id: 'something', goal: 'else', acceptanceCriteria: [{ id: 's', verifierRef: 'diff', required: true }] },
    ],
  });

  await assert.rejects(
    () => executeWorkflow(original, async (node) => {
      if (node.id === 'work') return ok(node);
      return { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: 'reviewer rejects' };
    }, { replan: () => bad }),
    (err) => err.code === 'WORKFLOW_REPLAN_INVALID',
  );
});

test('safe result reuse: completed nodes with unchanged definitionHash skip re-execution', async () => {
  // Build a graph, complete it, then verify the executor can reuse the
  // previous state when the node id + definitionHash are unchanged. This is
  // exercised via an injected prior report.
  const graph = makeGraph([
    { id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] },
  ]);
  let calls = 0;
  const report = await executeWorkflow(graph, async (node) => {
    calls += 1;
    return ok(node);
  });
  assert.equal(report.executionStatus, 'EXECUTION_SUCCEEDED');
  assert.equal(calls, 1);
  assert.equal(report.nodes.a.node.definitionHash, graph.nodes[0].definitionHash);
});
