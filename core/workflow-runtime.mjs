// Level 2 Task 3: sequential DAG executor.
//
// Concurrency defaults to 1 (Task 5 will add a bounded scheduler). The
// executor emits a structured report whose ``executionStatus`` is one of
// ``EXECUTION_SUCCEEDED``, ``FAILED`` or ``HALTED``; there is no
// ``COMPLETED`` value here — only the Runtime ``finish`` Decision with a
// valid EventStore integrity check can map to final completion.

import { randomUUID } from 'node:crypto';
import { topologicalOrder } from './task-graph.mjs';

export class WorkflowRuntimeError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'WorkflowRuntimeError';
    this.code = code;
    if (details) this.details = details;
  }
}

const NODE_STATUSES = new Set(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'HALTED']);

export async function executeWorkflow(graph, runNode, options = {}) {
  if (!graph || typeof graph !== 'object') {
    throw new WorkflowRuntimeError('WORKFLOW_GRAPH_INVALID', 'graph must be an object');
  }
  if (typeof runNode !== 'function') {
    throw new WorkflowRuntimeError('WORKFLOW_HANDLER_INVALID', 'runNode must be a function');
  }
  if (!Array.isArray(graph.nodes)) {
    throw new WorkflowRuntimeError('WORKFLOW_GRAPH_INVALID', 'graph.nodes must be an array');
  }
  const runId = options.runId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new WorkflowRuntimeError('WORKFLOW_CONCURRENCY_INVALID', `concurrency must be an integer in [1,16], got ${concurrency}`);
  }
  const audit = options.audit ?? null;
  const selectFallback = options.selectFallback ?? null;
  const replan = options.replan ?? null;

  const order = topologicalOrder(graph);
  const states = new Map();
  for (const node of graph.nodes) {
    states.set(node.id, {
      node,
      status: 'PENDING',
      attempts: 0,
      agentId: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      output: null,
      evidenceClaims: [],
      message: '',
    });
  }

  const completed = new Set();
  const failed = new Set();
  const blocked = new Set();
  const halted = new Set();
  const running = new Set();
  let replanned = false;

  function record(node, patch) {
    const prev = states.get(node.id);
    const next = { ...prev, ...patch };
    if (!NODE_STATUSES.has(next.status)) {
      throw new WorkflowRuntimeError('WORKFLOW_NODE_STATUS_INVALID', `node ${node.id} produced unknown status ${next.status}`);
    }
    states.set(node.id, Object.freeze(next));
  }

  function nodeIsBlocked(node) {
    for (const dep of node.dependencies) {
      if (failed.has(dep) || halted.has(dep) || blocked.has(dep)) return true;
    }
    return false;
  }

  function executionStatus() {
    if (halted.size > 0) return 'HALTED';
    if (failed.size > 0) return 'FAILED';
    if (blocked.size > 0) return 'FAILED';
    return 'EXECUTION_SUCCEEDED';
  }

  async function invoke(node, attempt, agentId, previousResult) {
    const ctx = {
      taskId: graph.task.id,
      runId,
      nodeId: node.id,
      attempt,
      agentId,
      previousResult: previousResult ?? null,
      sandboxPath: options.sandboxPath ?? null,
    };
    return runNode(node, ctx);
  }

  async function runOne(node) {
    running.add(node.id);
    const startedAtIso = new Date().toISOString();
    record(node, { status: 'RUNNING', startedAt: startedAtIso, attempts: (states.get(node.id).attempts ?? 0) + 1 });
    if (audit?.nodeStarted) {
      audit.nodeStarted({ taskId: graph.task.id, runId, nodeId: node.id });
    }
    let result;
    try {
      result = await invoke(node, 1, null, null);
    } catch (err) {
      result = {
        success: false,
        output: null,
        evidenceClaims: [],
        cost: 0,
        usage: {},
        message: err?.message ?? String(err),
      };
    }
    const finishedAtIso = new Date().toISOString();
    const durationMs = new Date(finishedAtIso).getTime() - new Date(startedAtIso).getTime();
    if (!result || typeof result !== 'object') {
      record(node, {
        status: 'FAILED',
        finishedAt: finishedAtIso,
        durationMs,
        output: null,
        evidenceClaims: [],
        message: 'handler returned non-object result',
      });
      failed.add(node.id);
      if (audit?.nodeFailed) audit.nodeFailed({ taskId: graph.task.id, runId, nodeId: node.id, reason: 'non-object result' });
      return;
    }
    if (result.success) {
      record(node, {
        status: 'SUCCEEDED',
        finishedAt: finishedAtIso,
        durationMs,
        output: result.output ?? null,
        evidenceClaims: result.evidenceClaims ?? [],
        message: result.message ?? '',
        agentId: result.agentId ?? states.get(node.id).agentId,
      });
      completed.add(node.id);
      if (audit?.nodeFinished) {
        audit.nodeFinished({ taskId: graph.task.id, runId, nodeId: node.id, status: 'SUCCEEDED', durationMs });
      }
    } else {
      record(node, {
        status: 'FAILED',
        finishedAt: finishedAtIso,
        durationMs,
        output: result.output ?? null,
        evidenceClaims: result.evidenceClaims ?? [],
        message: result.message ?? 'handler reported failure',
        agentId: result.agentId ?? states.get(node.id).agentId,
      });
      failed.add(node.id);
      if (audit?.nodeFailed) audit.nodeFailed({ taskId: graph.task.id, runId, nodeId: node.id, reason: result.message ?? 'failed' });
    }
    running.delete(node.id);
  }

  function blockDependants(node) {
    for (const other of graph.nodes) {
      if (other.dependencies.includes(node.id) && states.get(other.id).status === 'PENDING') {
        record(other, { status: 'BLOCKED', message: `dependency ${node.id} did not succeed` });
        blocked.add(other.id);
      }
    }
  }

  // Sequential scheduling loop (Task 5 will replace with a parallel scheduler).
  const orderById = new Map(order.map((id, idx) => [id, idx]));
  while (true) {
    let progressed = false;
    const ready = graph.nodes
      .filter((n) => states.get(n.id).status === 'PENDING' && !nodeIsBlocked(n))
      .sort((a, b) => orderById.get(a.id) - orderById.get(b.id));
    if (ready.length === 0) break;
    for (const node of ready) {
      // Re-check: a previous node in this batch may have just failed and
      // marked this node's dependency as failed, so it is now blocked.
      if (states.get(node.id).status !== 'PENDING' || nodeIsBlocked(node)) continue;
      await runOne(node);
      progressed = true;
      if (states.get(node.id).status === 'FAILED') {
        blockDependants(node);
      }
      if (running.size >= concurrency) break;
    }
    if (!progressed) break;
    // If everything that could run has run but the executor is still here, the
    // remaining nodes must be blocked. Mark them so the report is complete.
    for (const node of graph.nodes) {
      if (states.get(node.id).status === 'PENDING' && nodeIsBlocked(node)) {
        record(node, { status: 'BLOCKED', message: 'dependency failed before this node could run' });
        blocked.add(node.id);
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const totalCost = [...states.values()].reduce((acc, s) => acc + (s.output?.cost ?? 0), 0);
  const evidenceClaims = [...states.values()].flatMap((s) => s.evidenceClaims ?? []);
  const nodes = Object.freeze(Object.fromEntries([...states.entries()].map(([id, s]) => [id, { ...s, node: { id: s.node.id, goal: s.node.goal, definitionHash: s.node.definitionHash } }])));
  return Object.freeze({
    taskId: graph.task.id,
    runId,
    executionStatus: executionStatus(),
    startedAt,
    finishedAt,
    nodes,
    cost: totalCost,
    evidenceClaims: Object.freeze(evidenceClaims),
  });
}
