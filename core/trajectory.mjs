// Level 4 Task 1: versioned trajectory projection.
//
// recordRun() normalizes a Level 2/3 run report (orchestrator report or
// pipeline report) into an append-only trajectory row. Trajectory rows are a
// rebuildable observability projection — DevFlow EventStore remains the sole
// source of truth for governed facts. queryTrajectory() is the deterministic
// filter the dashboard reuses; trajectorySummary() aggregates the answers
// Level 4 must provide: success rate, cost, latency, failure distribution.

export class TrajectoryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TrajectoryError';
    this.code = code;
    if (details) this.details = details;
  }
}

const FAILURE_CLASSES = new Set([
  'none',
  'failed-dependency',
  'budget',
  'deadline',
  'no-candidate',
  'approval',
  'stage-failed',
  'quarantined',
  'evaluator-reject',
]);

function classifyFailure(report) {
  if (report.finalStatus === 'QUARANTINED') return 'quarantined';
  if (report.finalStatus === 'AWAITING_APPROVAL') return 'approval';
  if (report.executionStatus !== 'EXECUTION_SUCCEEDED' && report.executionStatus !== undefined) {
    const nodes = report.nodes ?? {};
    if (Object.values(nodes).some((n) => n.status === 'BLOCKED')) return 'failed-dependency';
    if (report.actionStatus === 'stage_failed') return 'stage-failed';
    return 'stage-failed';
  }
  if (report.actionStatus === 'no_candidates') return 'no-candidate';
  const decision = report.decision ?? {};
  if (decision.reason?.includes('budget')) return 'budget';
  if (decision.reason?.includes('deadline')) return 'deadline';
  return 'none';
}

function latencyMs(report) {
  if (typeof report.latencyMs === 'number') return report.latencyMs;
  if (report.startedAt && report.finishedAt) {
    const a = Date.parse(report.startedAt);
    const b = Date.parse(report.finishedAt);
    if (!Number.isNaN(a) && !Number.isNaN(b)) return Math.max(0, b - a);
  }
  return null;
}

export function recordRun({ run, projectionVersion = '1.0.0' }) {
  if (!run || typeof run !== 'object' || typeof run.runId !== 'string' || !run.runId) {
    throw new TrajectoryError('TRAJECTORY_RUN_INVALID', 'run must carry a non-empty runId');
  }
  const agentIds = [];
  if (Array.isArray(run.routing)) {
    for (const entry of run.routing) agentIds.push(entry.agentId);
  } else if (run.routing && typeof run.routing === 'object') {
    for (const entry of Object.values(run.routing)) {
      if (entry && typeof entry.agentId === 'string') agentIds.push(entry.agentId);
    }
  }
  if (run.nodes && typeof run.nodes === 'object') {
    for (const node of Object.values(run.nodes)) {
      if (node && typeof node.agentId === 'string' && !agentIds.includes(node.agentId)) agentIds.push(node.agentId);
    }
  }
  agentIds.sort();
  const evidenceRefs = [];
  if (Array.isArray(run.evidenceClaims)) {
    for (const claim of run.evidenceClaims) {
      if (claim && typeof claim.kind === 'string') evidenceRefs.push(claim.kind);
    }
  }
  if (Array.isArray(run.trustedEvidenceIds)) {
    for (const id of run.trustedEvidenceIds) evidenceRefs.push(`trusted:${id}`);
  }
  const failureClass = classifyFailure(run);
  return Object.freeze({
    runId: run.runId,
    taskId: run.taskId ?? null,
    workflowId: run.pipelineId ?? 'task',
    templateVersion: run.templateVersion ?? run.intentVersion ?? null,
    executionStatus: run.executionStatus ?? null,
    finalStatus: run.finalStatus ?? null,
    failureClass,
    agentIds,
    cost: typeof run.cost === 'number' ? run.cost : (typeof run.costUsd === 'number' ? run.costUsd : null),
    latencyMs: latencyMs(run),
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    artifactHashes: run.artifacts ? run.artifacts.map((a) => a.contentHash) : [],
    evidenceRefs: [...new Set(evidenceRefs)].sort(),
    projectionVersion,
  });
}

function inRange(value, min, max) {
  if (value == null) return true;
  if (min != null && value < min) return false;
  if (max != null && value > max) return false;
  return true;
}

export function queryTrajectory({ rows, agent = null, workflow = null, status = null, failureClass = null, minCost = null, maxCost = null, maxLatencyMs = null }) {
  if (!Array.isArray(rows)) {
    throw new TrajectoryError('TRAJECTORY_ROWS_INVALID', 'rows must be an array');
  }
  return rows.filter((row) => {
    if (agent && !(row.agentIds ?? []).includes(agent)) return false;
    if (workflow && row.workflowId !== workflow) return false;
    if (status && row.finalStatus !== status) return false;
    if (failureClass && row.failureClass !== failureClass) return false;
    if ((minCost != null || maxCost != null) && typeof row.cost !== 'number') return false;
    if (!inRange(row.cost, minCost, maxCost)) return false;
    if (maxLatencyMs != null && typeof row.latencyMs !== 'number') return false;
    if (maxLatencyMs != null && !inRange(row.latencyMs, null, maxLatencyMs)) return false;
    return true;
  });
}

function pct(part, total) {
  return total === 0 ? 0 : Math.round((part / total) * 1000) / 1000;
}

function groupCounts(rows, keyFn) {
  const counts = {};
  for (const row of rows) {
    const keys = keyFn(row) ?? [];
    for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function trajectorySummary(rows) {
  const total = rows.length;
  const succeeded = rows.filter((r) => r.finalStatus === 'COMPLETED' || r.finalStatus === 'EXECUTION_SUCCEEDED').length;
  const costs = rows.filter((r) => typeof r.cost === 'number').map((r) => r.cost);
  const latencies = rows.filter((r) => typeof r.latencyMs === 'number').map((r) => r.latencyMs);
  const avg = (xs) => (xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000);
  return {
    total,
    successRate: pct(succeeded, total),
    successCount: succeeded,
    failureCount: total - succeeded,
    avgCostUsd: avg(costs),
    avgLatencyMs: avg(latencies),
    failureDistribution: groupCounts(rows.filter((r) => r.failureClass !== 'none'), (r) => [r.failureClass]),
    byAgent: groupCounts(rows, (r) => r.agentIds),
    byWorkflow: groupCounts(rows, (r) => [r.workflowId]),
  };
}

export function assertFailureClass(value) {
  if (!FAILURE_CLASSES.has(value)) {
    throw new TrajectoryError('TRAJECTORY_FAILURE_CLASS_INVALID', `unknown failure class ${JSON.stringify(value)}`, { accepted: [...FAILURE_CLASSES] });
  }
}

// Append a normalized trajectory row to the store table `trajectory` (the
// dashboard's /api/evaluation projection source).
export function persistTrajectory(store, run) {
  if (!store || typeof store.appendRow !== 'function') {
    throw new TrajectoryError('TRAJECTORY_STORE_INVALID', 'persistTrajectory requires a StateStore');
  }
  const row = recordRun({ run });
  store.appendRow('trajectory', row);
  return row;
}
