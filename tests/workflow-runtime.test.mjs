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
