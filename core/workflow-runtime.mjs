// Level 2 Task 3-5: DAG executor with bounded concurrency, retry, fallback,
// reviewer correction and a single one-shot replan.
//
// Concurrency defaults to 1 (sequential). Task 5 opts into a bounded
// in-process scheduler. The executor emits a structured report whose
// ``executionStatus`` is one of ``EXECUTION_SUCCEEDED``, ``FAILED`` or
// ``HALTED``; there is no ``COMPLETED`` value here — only the Runtime
// ``finish`` Decision with a valid EventStore integrity check can map to
// final completion (Task 10).

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
  const replanFn = options.replan ?? null;

  let currentGraph = graph;
  const stateEntries = new Map();
  for (const node of currentGraph.nodes) {
    stateEntries.set(node.id, freshState(node));
  }
  const completed = new Set();
  const failed = new Set();
  const blocked = new Set();
  const halted = new Set();
  const running = new Set();
  let replanUsed = false;

  function freshState(node) {
    return {
      node: {
        id: node.id,
        goal: node.goal,
        definitionHash: node.definitionHash,
        kind: node.kind,
        maxAttempts: node.maxAttempts,
        fallbackAgentIds: node.fallbackAgentIds,
        maxReviewRounds: node.maxReviewRounds,
      },
      status: 'PENDING',
      attempts: 0,
      agentId: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      output: null,
      evidenceClaims: [],
      message: '',
      reviewedByReviewer: false,
    };
  }

  function record(node, patch) {
    const prev = stateEntries.get(node.id);
    const next = { ...prev, ...patch };
    if (!NODE_STATUSES.has(next.status)) {
      throw new WorkflowRuntimeError('WORKFLOW_NODE_STATUS_INVALID',`node ${node.id} produced unknown status ${next.status}`);
    }
    stateEntries.set(node.id, Object.freeze(next));
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

  function isTerminalFailure(state) {
    return state.attempts >= state.node.maxAttempts && state.status === 'FAILED';
  }

  async function runOne(node) {
    running.add(node.id);
    const state = stateEntries.get(node.id);
    const startedAtIso = new Date().toISOString();
    record(node, { status: 'RUNNING', startedAt: startedAtIso });
    if (audit?.nodeStarted) audit.nodeStarted({ taskId: currentGraph.task.id, runId, nodeId: node.id });
    const previousResult = state.output ? { ...state.output } : null;
    const ctx = {
      taskId: currentGraph.task.id,
      runId,
      nodeId: node.id,
      attempt: state.attempts + 1,
      agentId: state.agentId,
      previousResult,
      sandboxPath: options.sandboxPath ?? null,
    };
    let result;
    try {
      result = await runNode(node, ctx);
    } catch (err) {
      result = { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: err?.message ?? String(err) };
    }
    const finishedAtIso = new Date().toISOString();
    const durationMs = new Date(finishedAtIso).getTime() - new Date(startedAtIso).getTime();
    const updated = stateEntries.get(node.id);
    const attemptsUsed = updated.attempts + 1;
    if (!result || typeof result !== 'object') {
      record(node, { status: 'FAILED', finishedAt: finishedAtIso, durationMs, output: null, evidenceClaims: [], message: 'handler returned non-object result', attempts: attemptsUsed });
      failed.add(node.id);
      if (audit?.nodeFailed) audit.nodeFailed({ taskId: currentGraph.task.id, runId, nodeId: node.id, reason: 'non-object result' });
      running.delete(node.id);
      return;
    }
    const mergedAgentId = result.agentId ?? updated.agentId ?? null;
    if (result.success) {
      record(node, {
        status: 'SUCCEEDED',
        finishedAt: finishedAtIso,
        durationMs,
        output: result.output ?? null,
        evidenceClaims: result.evidenceClaims ?? [],
        message: result.message ?? '',
        agentId: mergedAgentId,
        attempts: attemptsUsed,
      });
      completed.add(node.id);
      failed.delete(node.id); // successful retry clears prior failed mark
      if (audit?.nodeFinished) audit.nodeFinished({ taskId: currentGraph.task.id, runId, nodeId: node.id, status: 'SUCCEEDED', durationMs });
    } else {
      record(node, {
        status: 'FAILED',
        finishedAt: finishedAtIso,
        durationMs,
        output: result.output ?? null,
        evidenceClaims: result.evidenceClaims ?? [],
        message: result.message ?? 'handler reported failure',
        agentId: mergedAgentId,
        attempts: attemptsUsed,
      });
      failed.add(node.id);
      if (audit?.nodeFailed) audit.nodeFailed({ taskId: currentGraph.task.id, runId, nodeId: node.id, reason: result.message ?? 'failed' });
    }
    running.delete(node.id);
  }

  function blockDependants(node) {
    for (const other of currentGraph.nodes) {
      if (other.dependencies.includes(node.id) && stateEntries.get(other.id).status === 'PENDING') {
        record(other, { status: 'BLOCKED', message: `dependency ${node.id} did not succeed` });
        blocked.add(other.id);
      }
    }
  }

  async function tryFallback(node, lastState) {
    if (!selectFallback) return null;
    const attempted = new Set();
    if (lastState.agentId) attempted.add(lastState.agentId);
    return selectFallback(node, lastState, [...attempted]);
  }

  async function attemptWithRetry(node) {
    const maxAttempts = node.maxAttempts ?? 1;
    let attemptIdx = 0;
    let fallbackUsed = false;
    while (attemptIdx < maxAttempts) {
      attemptIdx += 1;
      await runOne(node);
      const state = stateEntries.get(node.id);
      if (state.status === 'SUCCEEDED') return;
      if (state.attempts < maxAttempts) continue;
      // exhausted retries; try fallback once with a fresh attempt budget
      if (fallbackUsed) return;
      const fallback = await tryFallback(node, state);
      if (!fallback) return;
      fallbackUsed = true;
      record(node, { agentId: fallback, attempts: 0 });
      if (audit?.nodeRetried) audit.nodeRetried({ taskId: currentGraph.task.id, runId, nodeId: node.id, attempt: 0, reason: `fallback to ${fallback}` });
      attemptIdx = 0; // reset attempt counter so the fallback gets maxAttempts attempts
    }
  }

  async function tryReplanOnReviewFailure(reviewNode) {
    if (replanUsed || typeof replanFn !== 'function') return false;
    const failedReview = stateEntries.get(reviewNode.id);
    if (!failedReview || failedReview.status !== 'FAILED') return false;
    replanUsed = true;
    const partialReport = buildPartialReport();
    const newGraph = replanFn({ graph: currentGraph, report: partialReport, failedReviewNode: reviewNode });
    if (!newGraph || typeof newGraph !== 'object' || !Array.isArray(newGraph.nodes)) {
      throw new WorkflowRuntimeError('WORKFLOW_REPLAN_INVALID', 'replan() must return a TaskGraph-shaped object');
    }
    // Reuse completed nodes whose id + definitionHash are unchanged.
    validateReplacement(newGraph);
    const incoming = new Map(newGraph.nodes.map((n) => [n.id, n]));
    const reused = [];
    for (const [id, prev] of stateEntries) {
      const next = incoming.get(id);
      if (next && next.definitionHash === prev.node.definitionHash && prev.status === 'SUCCEEDED') {
        reused.push(id);
      } else if (next) {
        // drop the previous state — node shape changed, must re-run.
        stateEntries.set(id, freshState(next));
        completed.delete(id);
        failed.delete(id);
        blocked.delete(id);
        halted.delete(id);
      } else {
        stateEntries.delete(id);
        completed.delete(id);
        failed.delete(id);
        blocked.delete(id);
        halted.delete(id);
      }
    }
    for (const node of newGraph.nodes) {
      if (!stateEntries.has(node.id)) {
        stateEntries.set(node.id, freshState(node));
      }
    }
    currentGraph = newGraph;
    if (audit?.planRevised) {
      audit.planRevised({
        taskId: currentGraph.task.id,
        runId,
        reason: 'reviewer correction',
        graphRevision: 2,
      });
    }
    return true;
  }

  function validateReplacement(newGraph) {
    if (!Array.isArray(newGraph.nodes) || newGraph.nodes.length === 0) {
      throw new WorkflowRuntimeError('WORKFLOW_REPLAN_INVALID', 'replan graph must contain at least one node');
    }
    const kinds = new Set(newGraph.nodes.map((n) => n.kind ?? 'work'));
    if (!kinds.has('review') || !(kinds.has('correction') || newGraph.nodes.some((n) => /correction/i.test(n.id)))) {
      throw new WorkflowRuntimeError('WORKFLOW_REPLAN_INVALID', 'reviewer replan must include correction, verification and review nodes');
    }
  }

  function buildPartialReport() {
    const nodes = Object.fromEntries(
      [...stateEntries.entries()].map(([id, s]) => [id, {
        status: s.status,
        attempts: s.attempts,
        agentId: s.agentId,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        durationMs: s.durationMs,
        output: s.output,
        evidenceClaims: s.evidenceClaims,
        message: s.message,
      }]),
    );
    return {
      taskId: currentGraph.task.id,
      runId,
      executionStatus: executionStatus(),
      nodes,
    };
  }

  // Scheduling loop with bounded concurrency.
  const orderById = new Map(topologicalOrder(currentGraph).map((id, idx) => [id, idx]));
  while (true) {
    let progressed = false;
    const ready = currentGraph.nodes
      .filter((n) => stateEntries.get(n.id).status === 'PENDING' && !nodeIsBlocked(n))
      .sort((a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0));

    if (ready.length === 0) {
      // No ready nodes. Check whether a reviewer replan is possible.
      const failingReviewer = currentGraph.nodes.find((n) => n.kind === 'review' && stateEntries.get(n.id)?.status === 'FAILED');
      if (failingReviewer && !replanUsed) {
        const ok = await tryReplanOnReviewFailure(failingReviewer);
        if (ok) continue;
      }
      break;
    }

    const inflight = [];
    for (const node of ready) {
      if (stateEntries.get(node.id).status !== 'PENDING' || nodeIsBlocked(node)) continue;
      if (running.size + inflight.length >= concurrency) break;
      inflight.push(attemptWithRetry(node));
      progressed = true;
    }
    if (inflight.length === 0) break;
    await Promise.all(inflight);

    for (const node of currentGraph.nodes) {
      if (stateEntries.get(node.id).status === 'FAILED') {
        blockDependants(node);
      }
    }
    if (!progressed) break;
    for (const node of currentGraph.nodes) {
      if (stateEntries.get(node.id).status === 'PENDING' && nodeIsBlocked(node)) {
        record(node, { status: 'BLOCKED', message: 'dependency failed before this node could run' });
        blocked.add(node.id);
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const totalCost = [...stateEntries.values()].reduce((acc, s) => acc + (s.output?.cost ?? 0), 0);
  const evidenceClaims = [...stateEntries.values()].flatMap((s) => s.evidenceClaims ?? []);
  const nodes = Object.freeze(Object.fromEntries(
    [...stateEntries.entries()].map(([id, s]) => [id, {
      ...s,
      node: {
        id: s.node.id,
        goal: s.node.goal,
        definitionHash: s.node.definitionHash,
        kind: s.node.kind,
        maxAttempts: s.node.maxAttempts,
        fallbackAgentIds: s.node.fallbackAgentIds,
        maxReviewRounds: s.node.maxReviewRounds,
      },
    }]),
  ));
  return Object.freeze({
    taskId: currentGraph.task.id,
    runId,
    executionStatus: executionStatus(),
    startedAt,
    finishedAt,
    nodes,
    cost: totalCost,
    evidenceClaims: Object.freeze(evidenceClaims),
  });
}
