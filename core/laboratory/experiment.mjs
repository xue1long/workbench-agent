// Level 7 Task 2: experiment lab.
//
// Runs candidates in an isolated worktree (createChangeSandbox from
// Level 2), compares candidate vs baseline on the same frozen task/evaluator
// versions, and records environment/inputs/outputs/evidence/scores/cost/
// decision. Successful experiments return to the existing Level 5 approval
// and canary boundary; the lab NEVER auto-promotes.

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

export class ExperimentError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ExperimentError';
    this.code = code;
    if (details) this.details = details;
  }
}

const EXPERIMENT_TABLE = 'experiment';
const PROVENANCE_VERIFIER_VERSION = '1.0.0';

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function requireStore(store) {
  if (!store || typeof store.appendRow !== 'function' || typeof store.readRows !== 'function') {
    throw new ExperimentError('EXPERIMENT_STORE_INVALID', 'experiment lab requires a StateStore');
  }
}

export async function runExperiment({ store, candidate, baselineCases, env, evaluatorVersion, runCase }) {
  requireStore(store);
  if (!candidate || typeof candidate !== 'object' || !candidate.id) throw new ExperimentError('EXPERIMENT_CANDIDATE_INVALID', 'candidate with id is required');
  if (!Array.isArray(baselineCases) || baselineCases.length === 0) throw new ExperimentError('EXPERIMENT_BASELINE_INVALID', 'baselineCases must be a non-empty array');
  if (typeof runCase !== 'function') throw new ExperimentError('EXPERIMENT_RUNCASE_INVALID', 'runCase must be a function');
  const evaluator = evaluatorVersion ?? PROVENANCE_VERIFIER_VERSION;
  const id = `exp-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const inputs = [];
  const outputs = [];
  const evidence = [];
  let candidatePassed = 0;
  let baselinePassed = 0;
  let totalCost = 0;
  for (const taskCase of baselineCases) {
    const baseline = await runCase(taskCase, 'baseline', { sandbox: env.sandbox, evaluatorVersion: evaluator });
    const cand = await runCase(taskCase, 'candidate', { sandbox: env.sandbox, evaluatorVersion: evaluator, candidate });
    const baseOutcome = baseline?.outcome ?? { success: false };
    const candOutcome = cand?.outcome ?? { success: false };
    if (baseOutcome.success) baselinePassed += 1;
    if (candOutcome.success) candidatePassed += 1;
    totalCost += (cand?.cost ?? 0);
    inputs.push({ caseId: taskCase.id, task: taskCase, baselineVersion: 'baseline', candidateVersion: 'candidate' });
    outputs.push({ caseId: taskCase.id, baseline: baseOutcome, candidate: candOutcome });
    if (cand?.evidence) evidence.push(...(Array.isArray(cand.evidence) ? cand.evidence : [cand.evidence]));
  }
  const caseCount = baselineCases.length;
  const baseRate = baselinePassed / caseCount;
  const candidateRate = candidatePassed / caseCount;
  const improvement = Math.round((candidateRate - baseRate) * 1000) / 1000;
  const decision = candidateRate - baseRate >= 0.05 ? 'promote' : 'reject';
  const finishedAt = new Date().toISOString();
  const row = {
    id, candidateId: candidate.id, evaluatorVersion: evaluator,
    env: env.description ?? null, sandboxPath: env.sandbox?.sandboxPath ?? null,
    inputs: { caseIds: inputs.map((i) => i.caseId), caseCount },
    outputs: outputs.map((o) => ({ caseId: o.caseId, baselineSuccess: o.baseline.success, candidateSuccess: o.candidate.success })),
    evidenceRefs: evidence.map((e) => ({ kind: e?.kind ?? 'raw', ref: e?.sourcePath ?? e?.ref ?? null, contentHash: e?.contentHash ?? null })),
    scores: { baselineRate: baseRate, candidateRate, improvement },
    cost: Math.round(totalCost * 1000) / 1000,
    decision, startedAt, finishedAt,
    evaluatorHash: sha256(JSON.stringify({ evaluator, candidateRule: candidate.rule })),
  };
  store.appendRow(EXPERIMENT_TABLE, row);
  return row;
}

export function experimentHistory({ store, candidateId }) {
  requireStore(store);
  return store.readRows(EXPERIMENT_TABLE).filter((r) => r.candidateId === candidateId);
}

export function decisionFromResult(result) {
  if (!result) return 'reject';
  return result.decision === 'promote' ? 'promote' : 'reject';
}

// routeToCanary hands a successful experiment to the Level 5 boundary.
// The candidate is NOT promoted here; the lab exposes it to the existing
// approval + canary pipeline which is the only legal path to promotion.
export function routeToCanary({ experiment, canaryApi }) {
  if (!experiment || experiment.decision !== 'promote') {
    return { routed: false, reason: 'experiment is not promote-eligible' };
  }
  if (typeof canaryApi?.submitForCanary !== 'function') {
    return { routed: false, reason: 'canaryApi.submitForCanary is required' };
  }
  return { routed: true, ...canaryApi.submitForCanary({ experiment }) };
}
