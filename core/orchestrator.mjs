// Level 2 Task 10: orchestrator service.
//
// The orchestrator composes the validated TaskGraph, the workflow executor,
// the deterministic capability router, the change-sandbox collector, and
// the DevFlow Runtime adapter. It enforces every trust boundary:
//
//   * Agent evidence remains untrusted ``EvidenceClaim`` records.
//   * Only Runtime / Verifier output with ``verifier_version`` and valid
//     EventStore integrity may upgrade those claims to trusted Evidence.
//   * ``EXECUTION_SUCCEEDED`` only maps to ``COMPLETED`` when EventStore
//     integrity is valid AND the Runtime Decision is ``finish``.
//   * Without explicit approval the candidate change is preserved but never
//     submitted to Runtime.
//   * A deadline or budget breach stops the run before any further Action.

import { createHash } from 'node:crypto';
import { selectAgent } from './capabilities.mjs';
import { executeWorkflow } from './workflow-runtime.mjs';
import { createChangeSandbox as _createChangeSandbox, collectChangeSet as _collectChangeSet } from './change-sandbox.mjs';

export class OrchestratorError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    if (details) this.details = details;
  }
}

function deriveRequirement(node, task) {
  const budget = task.budget ?? null;
  const requiredTools = Array.isArray(node.requiredTools) ? node.requiredTools : [];
  return {
    capabilityRequired: node.capabilityRequired,
    requiredTools,
    risk: node.risk ?? (node.maxReviewRounds > 0 ? 'high' : 'low'),
    budget,
    estimatedContextTokens: typeof task.context?.estimatedContextTokens === 'number' ? task.context.estimatedContextTokens : 8000,
  };
}

function budgetRemaining(task) {
  const budget = task?.budget ?? {};
  return {
    costUsd: typeof budget.maxCostUsd === 'number' ? budget.maxCostUsd : Infinity,
    tokens: typeof budget.maxTokens === 'number' ? budget.maxTokens : Infinity,
  };
}

export class Orchestrator {
  constructor(dependencies = {}) {
    if (!dependencies.planner || typeof dependencies.planner.plan !== 'function') {
      throw new OrchestratorError('ORCHESTRATOR_DEPS_INVALID', 'planner.plan is required');
    }
    if (!dependencies.invoker || typeof dependencies.invoker.invoke !== 'function') {
      throw new OrchestratorError('ORCHESTRATOR_DEPS_INVALID', 'invoker.invoke is required');
    }
    if (!dependencies.changeSandbox || typeof dependencies.changeSandbox.create !== 'function') {
      throw new OrchestratorError('ORCHESTRATOR_DEPS_INVALID', 'changeSandbox.create is required');
    }
    if (!dependencies.runtime || typeof dependencies.runtime.run !== 'function') {
      throw new OrchestratorError('ORCHESTRATOR_DEPS_INVALID', 'runtime.run is required');
    }
    this._deps = dependencies;
    this._audit = dependencies.audit ?? null;
    this._createSandbox = dependencies.changeSandbox.create ?? _createChangeSandbox;
    this._collectChangeSet = dependencies.changeSandbox.collect ?? _collectChangeSet;
  }

  // Level 3 Task 4: optional per-node result transform (used by the pipeline
  // runner to persist declared artifacts and rewrite the node output to
  // artifact references before the workflow executor records it). Passed via
  // `options.transformResult(node, result)` like `options.skipNode`.
  _finalize(node, result, options) {
    if (typeof options?.transformResult === 'function') {
      return options.transformResult(node, result);
    }
    return result;
  }

  async planTask(task) {
    if (!task || typeof task !== 'object') {
      throw new OrchestratorError('ORCHESTRATOR_TASK_INVALID', 'task is required');
    }
    return this._deps.planner.plan(task);
  }

  async runTask(task, options = {}) {
    if (!task || typeof task !== 'object') {
      throw new OrchestratorError('ORCHESTRATOR_TASK_INVALID', 'task is required');
    }
    if (task.deadline) {
      const t = Date.parse(task.deadline);
      if (!Number.isNaN(t) && t < Date.now()) {
        throw new OrchestratorError('ORCHESTRATOR_DEADLINE_EXPIRED', `task deadline ${task.deadline} is in the past`);
      }
    }
    const graph = await this._deps.planner.plan(task);
    return this.runGraph(graph, task, options);
  }

  // Level 3 Task 3: runGraph runs an already-planned graph through the same
  // trust boundaries as runTask (routing, sandboxed invocation, candidate
  // collection, approval, Runtime submission, fail-closed mapping).
  // `options.skipNode` lets a caller (pipeline resume) short-circuit a node
  // that was verified in a prior run: it must return either
  // `{ skip: true, output, evidenceClaims, message }` or null.
  async runGraph(graph, task, options = {}) {
    const agents = (this._deps.agents?.list?.() ?? []);
    const routing = new Map();
    const usedAgentIds = new Set();
    const nodeSandboxes = new Map();
    const runNode = async (node, ctx) => {
      if (task.deadline && Date.parse(task.deadline) < Date.now()) {
        throw new OrchestratorError('ORCHESTRATOR_DEADLINE_EXPIRED', `deadline passed during ${node.id}`);
      }
      if (typeof options.skipNode === 'function') {
        const skipped = await options.skipNode(node, ctx);
        if (skipped && skipped.skip === true) {
          return this._finalize(node, {  
            success: true,
            output: skipped.output ?? null,
            evidenceClaims: skipped.evidenceClaims ?? [],
            cost: skipped.cost ?? 0,
            usage: skipped.usage ?? {},
            message: skipped.message ?? 'reused verified stage',
          });
        }
      }
      const budget = budgetRemaining(task);
      if (ctx.attempt === 1 && budget.costUsd <= 0) {
        throw new OrchestratorError('ORCHESTRATOR_BUDGET_EXHAUSTED', 'task budget exhausted before attempt');
      }
      const requirement = deriveRequirement(node, task);
      let selected;
      try {
        selected = selectAgent(requirement, agents, { availability: Object.fromEntries(agents.map((a) => [a.id, 1])) });
      } catch (err) {
        return { success: false, output: null, evidenceClaims: [], cost: 0, usage: {}, message: err.message };
      }
      routing.set(node.id, { agentId: selected.agent.id, score: selected.score, reasons: selected.reasons });
      usedAgentIds.add(selected.agent.id);
      this._audit?.agentSelected?.({
        taskId: task.id,
        runId: ctx.runId,
        nodeId: node.id,
        agentId: selected.agent.id,
        score: selected.score,
        reasons: selected.reasons,
      });
      const sandbox = await this._createSandbox({ repoRoot: this._deps.repoRoot, runId: ctx.runId });
      // Remember this exact worktree so the collect phase reuses the one the
      // agent actually wrote to (not a fresh empty sandbox).
      nodeSandboxes.set(node.id, sandbox);
      ctx.sandboxPath = sandbox.sandboxPath;
      const extraContext = typeof options.nodeContext === 'function'
        ? (await options.nodeContext(node, ctx)) ?? {}
        : {};
      const result = await this._deps.invoker.invoke(selected.agent, node, { sandboxPath: sandbox.sandboxPath, prompt: node.goal, ...extraContext });
      result.agentId = selected.agent.id;
      return this._finalize(node, result, options);
    };
    const executionReport = await executeWorkflow(graph, runNode, options);
    // Fail-closed gate: a workflow that did not fully succeed must never
    // submit a Runtime Action nor report completion. Preserve the execution
    // report so callers can resume from the last verified stage.
    if (executionReport.executionStatus !== 'EXECUTION_SUCCEEDED') {
      return {
        ...executionReport,
        sessionId: null,
        actionStatus: 'stage_failed',
        trustedEvidenceIds: [],
        decision: { kind: 'halt', reason: 'workflow did not fully succeed; no Runtime action submitted' },
        eventStoreIntegrity: { valid: false, last_sequence: 0, error: 'no Runtime call' },
        finalStatus: 'FAILED',
      };
    }
    const candidates = [];
    for (const [nodeId, state] of Object.entries(executionReport.nodes)) {
      if (state.status === 'SUCCEEDED') {
        const sandbox = nodeSandboxes.get(nodeId)
          ?? await this._createSandbox({ repoRoot: this._deps.repoRoot, runId: `${executionReport.runId}-${nodeId}` });
        try {
          const changeSet = await this._collectChangeSet(sandbox, { baseCommit: sandbox.baseCommit });
          // A node whose work produced no file changes has nothing to govern;
          // it contributes no candidate (doc stages write artifacts instead).
          if (Array.isArray(changeSet.edits) && changeSet.edits.length > 0) {
            candidates.push({ nodeId, changeSet });
          }
        } finally {
          await sandbox.cleanup();
          nodeSandboxes.delete(nodeId);
        }
      }
    }
    if (candidates.length === 0) {
      return {
        ...executionReport,
        sessionId: null,
        actionStatus: 'no_candidates',
        trustedEvidenceIds: [],
        decision: { kind: 'halt', reason: 'no successful nodes produced candidates' },
        eventStoreIntegrity: { valid: false, last_sequence: 0, error: 'no Runtime call' },
        finalStatus: 'FAILED',
      };
    }
    const candidate = candidates[0];
    let approval = options.approveChangeSet?.(candidate.changeSet);
    if (!approval || approval.approved !== true) {
      return {
        ...executionReport,
        sessionId: null,
        actionStatus: 'awaiting_approval',
        trustedEvidenceIds: [],
        decision: { kind: 'continue', reason: 'awaiting human approval' },
        eventStoreIntegrity: { valid: true, last_sequence: 0, error: null },
        finalStatus: 'AWAITING_APPROVAL',
        candidates: candidates.map((c) => ({ nodeId: c.nodeId, patchSha256: c.changeSet.patchSha256, changedFiles: c.changeSet.changedFiles })),
      };
    }
    if (typeof approval.changeSetSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(approval.changeSetSha256)) {
      approval.changeSetSha256 = createHash('sha256').update(JSON.stringify(candidate.changeSet.edits)).digest('hex');
    }
    const result = await this._deps.runtime.run({
      workspace: this._deps.repoRoot,
      intent: { id: task.id, version: '1.0.0' },
      changeSet: candidate.changeSet,
      sessionId: approval.sessionId ?? `session-${executionReport.runId}`,
      approval,
    });
    return {
      ...executionReport,
      sessionId: result.sessionId,
      actionStatus: result.actionStatus,
      trustedEvidenceIds: result.evidenceIds ?? [],
      decision: result.decision,
      eventStoreIntegrity: result.eventStoreIntegrity,
      finalStatus: result.finalStatus,
      routing: Object.fromEntries(routing),
      candidates: candidates.map((c) => ({ nodeId: c.nodeId, patchSha256: c.changeSet.patchSha256, changedFiles: c.changeSet.changedFiles })),
    };
  }
}
