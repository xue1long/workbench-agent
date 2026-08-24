// Level 2 Task 1: validated Task / DAG contract.
//
// All exported task, node and graph objects are frozen plain objects — the
// orchestrator never mutates them. The validator is the single entry point
// for graph construction so callers cannot bypass it. canonicalJson and the
// definition/input hashes are used to govern safe result reuse after a
// callback-driven replan (Task 4).

import { createHash } from 'node:crypto';

export const ACCEPTANCE_VERIFIER_REFS = Object.freeze([
  'diff',
  'scope',
  'test',
  'budget',
  'dependency',
  'architecture',
  'audit',
]);

const ACCEPTANCE_VERIFIER_SET = new Set(ACCEPTANCE_VERIFIER_REFS);

export class TaskGraphError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TaskGraphError';
    this.code = code;
    if (details) {
      this.details = details;
    }
  }
}

export function canonicalJson(value) {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = val[k];
      }
      return sorted;
    }
    return val;
  });
}

function sha256Hex(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validateAcceptanceCriteria(node) {
  if (!Array.isArray(node.acceptanceCriteria) || node.acceptanceCriteria.length === 0) {
    throw new TaskGraphError('TASK_NODE_NO_ACCEPTANCE',`node ${node.id} must declare at least one acceptance criterion`);
  }
  const seen = new Set();
  for (const acc of node.acceptanceCriteria) {
    if (!acc || typeof acc !== 'object') {
      throw new TaskGraphError('TASK_NODE_ACCEPTANCE_INVALID',`node ${node.id} has non-object acceptance criterion`);
    }
    const { id, verifierRef, required } = acc;
    if (typeof id !== 'string' || !id.trim()) {
      throw new TaskGraphError('TASK_NODE_ACCEPTANCE_INVALID',`node ${node.id} acceptance criterion missing id`);
    }
    if (seen.has(id)) {
      throw new TaskGraphError('TASK_NODE_DUPLICATE_ACCEPTANCE',`node ${node.id} has duplicate acceptance id ${id}`);
    }
    seen.add(id);
    if (typeof verifierRef !== 'string' || !ACCEPTANCE_VERIFIER_SET.has(verifierRef)) {
      throw new TaskGraphError('TASK_NODE_VERIFIER_REF_INVALID',`node ${node.id} acceptance ${id} uses unknown verifier ${JSON.stringify(verifierRef)}`, {
        accepted: [...ACCEPTANCE_VERIFIER_SET],
      });
    }
    if (typeof required !== 'boolean') {
      throw new TaskGraphError('TASK_NODE_ACCEPTANCE_INVALID',`node ${node.id} acceptance ${id} must declare required as boolean`);
    }
  }
}

export function createTask(input) {
  if (!input || typeof input !== 'object') {
    throw new TaskGraphError('TASK_INPUT_INVALID', 'task input must be an object');
  }
  const { id, goal, context = {}, priority = 'normal', risk = 'medium', budget = null, deadline = null } = input;
  if (typeof id !== 'string' || !id.trim()) {
    throw new TaskGraphError('TASK_ID_INVALID', 'task id must be a non-empty string');
  }
  if (typeof goal !== 'string' || !goal.trim()) {
    throw new TaskGraphError('TASK_GOAL_EMPTY', 'task goal must be a non-empty string');
  }
  if (budget !== null) {
    if (typeof budget !== 'object') {
      throw new TaskGraphError('TASK_BUDGET_INVALID', 'task budget must be an object or null');
    }
    for (const [key, val] of Object.entries(budget)) {
      if (typeof val !== 'number' || Number.isNaN(val)) {
        throw new TaskGraphError('TASK_BUDGET_INVALID', `task budget.${key} must be a number`);
      }
      if (val < 0) {
        throw new TaskGraphError('TASK_BUDGET_NEGATIVE', `task budget.${key} must be non-negative`);
      }
    }
  }
  if (deadline !== null) {
    const t = Date.parse(deadline);
    if (Number.isNaN(t)) {
      throw new TaskGraphError('TASK_DEADLINE_INVALID', `task deadline must be an ISO date string, got ${JSON.stringify(deadline)}`);
    }
  }
  const normalized = { id, goal, context, priority, risk, budget, deadline };
  const inputHash = sha256Hex(normalized);
  return Object.freeze({
    id,
    goal,
    context: Object.freeze({ ...context }),
    priority,
    risk,
    budget: budget ? Object.freeze({ ...budget }) : null,
    deadline,
    inputHash,
  });
}

function validateNode(node, ids) {
  if (!node || typeof node !== 'object') {
    throw new TaskGraphError('TASK_NODE_INVALID', 'each node must be an object');
  }
  const { id, goal, dependencies = [], capabilityRequired = null, requiredTools = [], kind = 'work', maxAttempts = 1, maxReviewRounds = 0, fallbackAgentIds = [] } = node;
  if (typeof id !== 'string' || !id.trim()) {
    throw new TaskGraphError('TASK_NODE_ID_INVALID', 'node id must be a non-empty string');
  }
  if (typeof goal !== 'string' || !goal.trim()) {
    throw new TaskGraphError('TASK_NODE_GOAL_EMPTY',`node ${id} must declare a non-empty goal`);
  }
  if (ids.has(id)) {
    throw new TaskGraphError('TASK_GRAPH_DUPLICATE_NODE', `duplicate node id ${id}`);
  }
  ids.add(id);
  if (!Array.isArray(dependencies)) {
    throw new TaskGraphError('TASK_NODE_DEPENDENCIES_INVALID',`node ${id} dependencies must be an array`);
  }
  if (dependencies.includes(id)) {
    throw new TaskGraphError('TASK_GRAPH_SELF_DEPENDENCY',`node ${id} cannot depend on itself`);
  }
  for (const dep of dependencies) {
    if (typeof dep !== 'string' || !dep.trim()) {
      throw new TaskGraphError('TASK_NODE_DEPENDENCY_INVALID',`node ${id} has invalid dependency ${JSON.stringify(dep)}`);
    }
  }
  if (maxAttempts !== undefined && (typeof maxAttempts !== 'number' || maxAttempts < 1 || !Number.isInteger(maxAttempts))) {
    throw new TaskGraphError('TASK_NODE_MAX_ATTEMPTS_INVALID',`node ${id} maxAttempts must be a positive integer`);
  }
  if (maxReviewRounds !== undefined && (typeof maxReviewRounds !== 'number' || maxReviewRounds < 0 || !Number.isInteger(maxReviewRounds))) {
    throw new TaskGraphError('TASK_NODE_MAX_REVIEW_ROUNDS_INVALID',`node ${id} maxReviewRounds must be a non-negative integer`);
  }
  validateAcceptanceCriteria(node);

  const normalized = {
    id,
    goal,
    dependencies: [...dependencies].sort(),
    capabilityRequired,
    requiredTools: [...requiredTools].sort(),
    kind,
    maxAttempts,
    maxReviewRounds,
    fallbackAgentIds: [...fallbackAgentIds].sort(),
    acceptanceCriteria: node.acceptanceCriteria.map((a) => ({ id: a.id, verifierRef: a.verifierRef, required: a.required })),
  };
  const definitionHash = sha256Hex(normalized);
  return Object.freeze({
    id,
    goal,
    dependencies: Object.freeze([...dependencies]),
    capabilityRequired,
    requiredTools: Object.freeze([...requiredTools]),
    kind,
    maxAttempts,
    maxReviewRounds,
    fallbackAgentIds: Object.freeze([...fallbackAgentIds]),
    acceptanceCriteria: Object.freeze(
      node.acceptanceCriteria.map((a) =>
        Object.freeze({ id: a.id, verifierRef: a.verifierRef, required: a.required }),
      ),
    ),
    definitionHash,
  });
}

export function createTaskGraph({ task, nodes }) {
  if (!task) {
    throw new TaskGraphError('TASK_GRAPH_TASK_MISSING', 'graph must include a task');
  }
  if (!Array.isArray(nodes)) {
    throw new TaskGraphError('TASK_GRAPH_NODES_INVALID', 'nodes must be an array');
  }
  const ids = new Set();
  const seenNodeIds = new Set();
  const validated = nodes.map((n) => {
    const out = validateNode(n, seenNodeIds);
    ids.add(out.id);
    return out;
  });
  for (const node of validated) {
    for (const dep of node.dependencies) {
      if (!ids.has(dep)) {
        throw new TaskGraphError('TASK_GRAPH_MISSING_DEPENDENCY',`node ${node.id} depends on unknown node ${dep}`);
      }
    }
  }
  // Kahn's algorithm for topological order; reject cycles explicitly.
  const order = topologicalOrderFromNodes(validated);
  if (order.length !== validated.length) {
    throw new TaskGraphError('TASK_GRAPH_CYCLE', 'graph contains a cycle');
  }
  return Object.freeze({
    task,
    nodes: Object.freeze(validated),
    nodeIds: Object.freeze(validated.map((n) => n.id)),
    graphHash: sha256Hex({ task: { id: task.id, inputHash: task.inputHash }, nodes: validated.map((n) => ({ id: n.id, definitionHash: n.definitionHash })) }),
  });
}

function topologicalOrderFromNodes(nodes) {
  const indeg = new Map();
  const adj = new Map();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const n of nodes) {
    for (const dep of n.dependencies) {
      adj.get(dep).push(n.id);
      indeg.set(n.id, (indeg.get(n.id) || 0) + 1);
    }
  }
  const ready = [];
  for (const [id, d] of indeg) {
    if (d === 0) ready.push(id);
  }
  ready.sort();
  const result = [];
  while (ready.length > 0) {
    const id = ready.shift();
    result.push(id);
    for (const next of adj.get(id)) {
      const v = indeg.get(next) - 1;
      indeg.set(next, v);
      if (v === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  return result;
}

export function topologicalOrder(graph) {
  return topologicalOrderFromNodes(graph.nodes);
}

export function readyNodeIds(graph, completedIds, failedIds, runningIds) {
  const completed = new Set(completedIds);
  const failed = new Set(failedIds);
  const running = new Set(runningIds);
  const ready = [];
  for (const node of graph.nodes) {
    if (completed.has(node.id) || failed.has(node.id) || running.has(node.id)) continue;
    let allDepsSatisfied = true;
    for (const dep of node.dependencies) {
      if (!completed.has(dep)) {
        allDepsSatisfied = false;
        break;
      }
    }
    if (allDepsSatisfied) ready.push(node.id);
  }
  ready.sort();
  return ready;
}
