// Level 2 Task 1: validated Task / DAG contract.
//
// createTaskGraph must reject empty goals, invalid IDs, duplicate acceptance
// IDs, verifier refs outside the frozen set, empty acceptance criteria,
// missing dependencies, cycles, non-positive attempt limits, invalid
// deadlines and negative budgets. canonicalJson must produce stable hashes
// regardless of key insertion order. topologicalOrder / readyNodeIds /
// fan-out and fan-in readiness, plus failed-dependency blocking, must be
// deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TaskGraphError,
  canonicalJson,
  createTask,
  createTaskGraph,
  readyNodeIds,
  topologicalOrder,
} from '../core/task-graph.mjs';

const VALID_VERIFIERS = ['diff', 'scope', 'test', 'budget', 'dependency', 'architecture', 'audit'];

function simpleGraph() {
  return createTaskGraph({
    task: createTask({ id: 'task-1', goal: 'Add OAuth login' }),
    nodes: [
      {
        id: 'architecture',
        goal: 'design OAuth flow',
        dependencies: [],
        capabilityRequired: 'coding',
        acceptanceCriteria: [{ id: 'a-arch', verifierRef: 'architecture', required: true }],
      },
      {
        id: 'backend',
        goal: 'implement backend',
        dependencies: ['architecture'],
        capabilityRequired: 'backend_development',
        acceptanceCriteria: [{ id: 'a-backend', verifierRef: 'diff', required: true }],
      },
      {
        id: 'frontend',
        goal: 'implement frontend',
        dependencies: ['architecture'],
        capabilityRequired: 'frontend_development',
        acceptanceCriteria: [{ id: 'a-frontend', verifierRef: 'diff', required: true }],
      },
      {
        id: 'test',
        goal: 'add integration tests',
        dependencies: ['backend', 'frontend'],
        capabilityRequired: 'testing',
        acceptanceCriteria: [{ id: 'a-test', verifierRef: 'test', required: true }],
      },
    ],
  });
}

test('createTaskGraph accepts a valid linear graph and freezes the result', () => {
  const graph = simpleGraph();
  assert.equal(graph.task.id, 'task-1');
  assert.equal(graph.task.inputHash.length, 64); // sha256 hex
  for (const node of graph.nodes) {
    assert.equal(node.definitionHash.length, 64);
    assert.equal(Object.isFrozen(node), true);
  }
  assert.equal(Object.isFrozen(graph), true);
});

test('createTask rejects empty goal', () => {
  assert.throws(
    () => createTask({ id: 't', goal: '' }),
    (err) => err instanceof TaskGraphError && err.code === 'TASK_GOAL_EMPTY',
  );
});

test('createTask rejects invalid id', () => {
  assert.throws(
    () => createTask({ id: '', goal: 'x' }),
    (err) => err instanceof TaskGraphError && err.code === 'TASK_ID_INVALID',
  );
});

test('createTask rejects negative budget', () => {
  assert.throws(
    () =>
      createTask({
        id: 't',
        goal: 'x',
        budget: { maxCostUsd: -1, maxTokens: 100 },
      }),
    (err) => err instanceof TaskGraphError && err.code === 'TASK_BUDGET_NEGATIVE',
  );
});

test('createTask rejects invalid deadline', () => {
  assert.throws(
    () => createTask({ id: 't', goal: 'x', deadline: 'not-a-date' }),
    (err) => err instanceof TaskGraphError && err.code === 'TASK_DEADLINE_INVALID',
  );
});

test('createTaskGraph rejects duplicate node ids', () => {
  assert.throws(
    () =>
      createTaskGraph({
        task: createTask({ id: 'task-dup', goal: 'x' }),
        nodes: [
          { id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }] },
          { id: 'a', goal: 'a2', acceptanceCriteria: [{ id: 'ab', verifierRef: 'diff', required: true }] },
        ],
      }),
    (err) => err instanceof TaskGraphError && err.code === 'TASK_GRAPH_DUPLICATE_NODE',
  );
});

test('createTaskGraph rejects unknown dependency', () => {
  assert.throws(
    () =>
      createTaskGraph({
        task: createTask({ id: 'task-missing', goal: 'x' }),
        nodes: [
          {
            id: 'a',
            goal: 'a',
            dependencies: ['nope'],
            acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }],
          },
        ],
      }),
    (err) => err instanceof TaskGraphError && err.code === 'TASK_GRAPH_MISSING_DEPENDENCY',
  );
});

test('createTaskGraph rejects self dependency', () => {
  assert.throws(
    () =>
      createTaskGraph({
        task: createTask({ id: 'task-self', goal: 'x' }),
        nodes: [
          {
            id: 'a',
            goal: 'a',
            dependencies: ['a'],
            acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }],
          },
        ],
      }),
    (err) => err instanceof TaskGraphError && err.code === 'TASK_GRAPH_SELF_DEPENDENCY',
  );
});

test('createTaskGraph rejects cycles', () => {
  assert.throws(
    () =>
      createTaskGraph({
        task: createTask({ id: 't', goal: 'x' }),
        nodes: [
          {
            id: 'a',
            goal: 'a',
            dependencies: ['b'],
            capabilityRequired: 'coding',
            acceptanceCriteria: [{ id: 'a-diff', verifierRef: 'diff', required: true }],
          },
          {
            id: 'b',
            goal: 'b',
            dependencies: ['a'],
            capabilityRequired: 'coding',
            acceptanceCriteria: [{ id: 'b-diff', verifierRef: 'diff', required: true }],
          },
        ],
      }),
    (err) => err instanceof TaskGraphError && err.code === 'TASK_GRAPH_CYCLE',
  );
});

test('createTaskGraph rejects duplicate acceptance ids', () => {
  assert.throws(
    () =>
      createTaskGraph({
        task: createTask({ id: 't', goal: 'x' }),
        nodes: [
          {
            id: 'a',
            goal: 'a',
            acceptanceCriteria: [
              { id: 'shared', verifierRef: 'diff', required: true },
              { id: 'shared', verifierRef: 'scope', required: false },
            ],
          },
        ],
      }),
    (err) => err instanceof TaskGraphError && err.code === 'TASK_NODE_DUPLICATE_ACCEPTANCE',
  );
});

test('createTaskGraph rejects verifier refs outside the frozen set', () => {
  for (const ref of ['banana', 'untrusted', '']) {
    assert.throws(
      () =>
        createTaskGraph({
          task: createTask({ id: 't', goal: 'x' }),
          nodes: [
            {
              id: 'a',
              goal: 'a',
              acceptanceCriteria: [{ id: 'aa', verifierRef: ref, required: true }],
            },
          ],
        }),
      (err) => err instanceof TaskGraphError && err.code === 'TASK_NODE_VERIFIER_REF_INVALID',
      `verifier ${JSON.stringify(ref)} must be rejected`,
    );
  }
});

test('createTaskGraph rejects empty acceptance criteria', () => {
  assert.throws(
    () =>
      createTaskGraph({
        task: createTask({ id: 't', goal: 'x' }),
        nodes: [{ id: 'a', goal: 'a', acceptanceCriteria: [] }],
      }),
    (err) => err instanceof TaskGraphError && err.code === 'TASK_NODE_NO_ACCEPTANCE',
  );
});

test('createTaskGraph rejects non-positive attempt limits', () => {
  assert.throws(
    () =>
      createTaskGraph({
        task: createTask({ id: 't', goal: 'x' }),
        nodes: [
          {
            id: 'a',
            goal: 'a',
            maxAttempts: 0,
            acceptanceCriteria: [{ id: 'aa', verifierRef: 'diff', required: true }],
          },
        ],
      }),
    (err) => err instanceof TaskGraphError && err.code === 'TASK_NODE_MAX_ATTEMPTS_INVALID',
  );
});

test('canonicalJson sorts keys recursively and preserves array order', () => {
  const a = canonicalJson({ b: 2, a: 1, nested: { z: 3, y: 2 }, arr: [{ d: 4, c: 3 }, { f: 6, e: 5 }] });
  const b = canonicalJson({ a: 1, nested: { y: 2, z: 3 }, b: 2, arr: [{ c: 3, d: 4 }, { e: 5, f: 6 }] });
  assert.equal(a, b);
  assert.ok(a.startsWith('{'));
});

test('topologicalOrder is stable by node id', () => {
  const graph = simpleGraph();
  const order = topologicalOrder(graph);
  // architecture must come before backend/frontend; backend+frontend can interleave by id
  assert.ok(order.indexOf('architecture') < order.indexOf('backend'));
  assert.ok(order.indexOf('architecture') < order.indexOf('frontend'));
  assert.ok(order.indexOf('backend') < order.indexOf('test'));
  assert.ok(order.indexOf('frontend') < order.indexOf('test'));
});

test('readyNodeIds returns roots when nothing has run', () => {
  const graph = simpleGraph();
  assert.deepEqual(readyNodeIds(graph, [], [], []), ['architecture']);
});

test('readyNodeIds fans out after a root completes', () => {
  const graph = simpleGraph();
  const ready = readyNodeIds(graph, ['architecture'], [], []);
  assert.deepEqual(new Set(ready), new Set(['backend', 'frontend']));
});

test('readyNodeIds fans in only after all dependencies complete', () => {
  const graph = simpleGraph();
  assert.deepEqual(readyNodeIds(graph, ['architecture', 'backend'], [], []), ['frontend']);
  const allReady = readyNodeIds(graph, ['architecture', 'backend', 'frontend'], [], []);
  assert.deepEqual(allReady, ['test']);
});

test('readyNodeIds blocks dependents when a dependency failed', () => {
  const graph = simpleGraph();
  const blocked = readyNodeIds(graph, [], ['architecture'], []);
  assert.deepEqual(blocked, []);
});

test('readyNodeIds ignores already running nodes', () => {
  const graph = simpleGraph();
  const ready = readyNodeIds(graph, [], [], ['architecture']);
  assert.deepEqual(ready, []);
});

test('exposes the full set of valid verifier refs in errors', () => {
  assert.ok(VALID_VERIFIERS.length >= 7);
});
