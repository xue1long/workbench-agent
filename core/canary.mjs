// Level 5 Task 5: human approval, canary and rollback.
//
// Promotion requires an explicit human approval record. Promoted candidates
// are canaried on at most maxFraction (default 10%) of eligible runs via a
// deterministic hash of (candidateId, runId). A regression breach (success
// rate drops below baseline - threshold after a minimum window) auto-disables
// the candidate (rolled-back) and rollback() returns the recorded
// rollbackTarget so the control plane restores the previous
// routing/workflow/meta-skill version. All history rows are append-only and
// survive rollback.

import { createHash } from 'node:crypto';
import { transitionCandidate, candidateHistory, activeCandidates } from './candidates.mjs';

export class CanaryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CanaryError';
    this.code = code;
    if (details) this.details = details;
  }
}

const CANARY_RUN_TABLE = 'canary_run';
const CANARY_RESULT_TABLE = 'canary_result';

function requireStore(store) {
  if (!store || typeof store.appendRow !== 'function' || typeof store.readRows !== 'function') {
    throw new CanaryError('CANARY_STORE_INVALID', 'canary operations require a StateStore');
  }
}

export function approve({ store, candidateId, actor, evidenceRef = null }) {
  requireStore(store);
  if (typeof actor !== 'string' || !actor.trim()) {
    throw new CanaryError('CANARY_APPROVER_INVALID', 'a human approver must be named');
  }
  return transitionCandidate({
    store, candidateId, to: 'approved',
    evidenceRef: evidenceRef ?? `human:${actor}`, actor,
  });
}

export function promote({ store, candidateId, actor = 'control-plane' }) {
  requireStore(store);
  const history = candidateHistory({ store, candidateId });
  const approvedEntry = history.find((h) => h.to === 'approved');
  if (!approvedEntry || !/^human:/.test(approvedEntry.evidenceRef ?? '')) {
    throw new CanaryError('CANARY_APPROVAL_REQUIRED', `candidate ${candidateId} requires explicit human approval before promotion`);
  }
  return transitionCandidate({ store, candidateId, to: 'promoted', evidenceRef: `human:${approvedEntry.actor ?? 'unknown'}`, actor });
}

function hashUnit(value) {
  return parseInt(createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8), 16) / 0xffffffff;
}

export function canarySlice({ store, candidateId, runId, maxFraction = 0.1 }) {
  requireStore(store);
  if (maxFraction <= 0 || maxFraction > 1) {
    throw new CanaryError('CANARY_FRACTION_INVALID', 'maxFraction must be in (0, 1]');
  }
  const u = hashUnit(`${candidateId}:${runId}`);
  const selected = u < maxFraction;
  store.appendRow(CANARY_RUN_TABLE, { candidateId, runId, selected, hash: u });
  return selected;
}

export function reportCanaryResult({ store, candidateId, runId, success }) {
  requireStore(store);
  store.appendRow(CANARY_RESULT_TABLE, { candidateId, runId, success: success === true });
  return { candidateId, runId, success: success === true };
}

export function canaryStatus({ store, candidateId, baselineSuccessRate = 0.9, minWindow = 5, threshold = 0.1 }) {
  requireStore(store);
  const results = store.readRows(CANARY_RESULT_TABLE).filter((r) => r.candidateId === candidateId);
  const total = results.length;
  const successCount = results.filter((r) => r.success).length;
  const successRate = total === 0 ? null : successCount / total;
  const windowMet = total >= minWindow;
  const breached = windowMet && successRate != null && baselineSuccessRate - successRate >= threshold;
  return {
    candidateId,
    total,
    successCount,
    successRate: successRate == null ? null : Math.round(successRate * 1000) / 1000,
    minWindow,
    windowMet,
    baselineSuccessRate,
    threshold,
    breached,
  };
}

export function autoDisable({ store, candidateId, actor = 'canary', baselineSuccessRate = 0.9, minWindow = 5, threshold = 0.1 }) {
  requireStore(store);
  const status = canaryStatus({ store, candidateId, baselineSuccessRate, minWindow, threshold });
  if (!status.breached) {
    return { disabled: false, status };
  }
  const t = transitionCandidate({ store, candidateId, to: 'rolled-back', evidenceRef: 'canary:regression-breach', actor });
  return { disabled: true, status, transition: t };
}

export function rollback({ store, candidateId, actor = 'control-plane' }) {
  requireStore(store);
  const candidates = store.readRows('candidate').filter((r) => r.id === candidateId);
  if (candidates.length === 0) throw new CanaryError('CANARY_CANDIDATE_NOT_FOUND', `candidate ${candidateId} not found`);
  const latest = candidates[candidates.length - 1];
  if (latest.status !== 'promoted') {
    throw new CanaryError('CANARY_ROLLBACK_STATUS_INVALID', `candidate ${candidateId} is ${latest.status}; only promoted candidates roll back`);
  }
  const transition = transitionCandidate({ store, candidateId, to: 'rolled-back', evidenceRef: 'rollback:human', actor });
  // History must remain intact: every record still readable.
  const history = candidateHistory({ store, candidateId });
  return {
    transition,
    rollbackTarget: latest.rollbackTarget,
    previousVersion: latest.rollbackTarget,
    historyCount: history.length,
  };
}

export function canaryRuns({ store, candidateId }) {
  requireStore(store);
  return store.readRows(CANARY_RUN_TABLE).filter((r) => r.candidateId === candidateId);
}

export function promotedCandidates({ store }) {
  requireStore(store);
  return activeCandidates({ store }).filter((c) => c.status === 'promoted');
}
